/**
 * The SCORE tab's "Rewrite from MIDI" bar over a sheet an older build wrote at
 * sounding pitch.
 *
 * The sequence: the artifact list comes back with the sheet flagged
 * (legacy_sounding_pitch, rewrite_from_midi), the bar shows over it, the
 * button posts /rewrite-from-midi for that sheet, and the tab is told so it
 * lists and reads the sheet again. A sheet this build wrote shows no bar; a
 * flagged sheet whose MIDI is gone says so and offers no button; a failed
 * rewrite says why.
 *
 * Run: `npx tsx src/components/layout/score/LegacySheetNotice.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { NotationArtifact } from '../../../lib/notationClient';

async function main(): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'Node', 'Event', 'MouseEvent', 'getComputedStyle']) {
    Object.defineProperty(g, key, { value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true, writable: true });
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { LegacySheetNotice } = await import('./LegacySheetNotice.tsx');
  const { act } = React;
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);

  const sheet = (extra: Partial<NotationArtifact>): NotationArtifact => ({
    id: 'e1__clar__musicxml',
    entry_id: 'e1',
    kind: 'musicxml',
    path: '/lib/e1/notation/clar.musicxml',
    engine: 'music21',
    engine_version: '9.1.0',
    created_at: 1,
    ...extra,
  });
  const posted: string[] = [];
  let reply: () => Response = () => new Response(JSON.stringify({ ok: true, artifact: sheet({ legacy_sounding_pitch: false }) }), { status: 200 });
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    posted.push(`${init?.method ?? 'GET'} ${String(url)}`);
    return reply();
  }) as typeof fetch;
  const told: Array<NotationArtifact | null> = [];
  const show = async (artifact: NotationArtifact) => {
    await act(async () => {
      root.render(React.createElement(LegacySheetNotice, { entryId: 'e1', artifact, onRewritten: (a: NotationArtifact | null) => { told.push(a); } }));
    });
  };
  const button = () => host.querySelector<HTMLButtonElement>('button');

  // A sheet this build wrote: no bar.
  await show(sheet({ legacy_sounding_pitch: false, rewrite_from_midi: false }));
  assert.equal(host.textContent, '');
  await show(sheet({ kind: 'midi' }));
  assert.equal(host.textContent, '');

  // A flagged sheet with its MIDI: the bar, and the button rewrites it.
  await show(sheet({ legacy_sounding_pitch: true, rewrite_from_midi: true }));
  assert.match(host.textContent ?? '', /older build wrote this sheet/);
  assert.equal(button()?.getAttribute('aria-label'), 'Rewrite this sheet from its MIDI at written pitch');
  assert.ok((button()?.className ?? '').includes('text-xs'), 'the key reads at 12px');
  await act(async () => {
    button()!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  assert.deepEqual(posted, ['POST /api/notation/e1/rewrite-from-midi/e1__clar__musicxml']);
  assert.equal(told.length, 1, 'the tab is told to list and read the sheet again');
  assert.equal(told[0]?.legacy_sounding_pitch, false);

  // The rewrite fails: the bar says why, and the tab is not told.
  reply = () => new Response(JSON.stringify({ detail: { ok: false, error: 'the MIDI this sheet was made from is not in the library' } }), { status: 404 });
  await act(async () => {
    button()!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(told.length, 1);
  assert.match(host.querySelector('[role="status"]')?.textContent ?? '', /Rewrite failed: the MIDI this sheet was made from is not in the library/);

  // A flagged sheet whose MIDI is gone: said so, no button.
  await show(sheet({ id: 'e1__gone__musicxml', legacy_sounding_pitch: true, rewrite_from_midi: false }));
  assert.match(host.textContent ?? '', /Its MIDI is not in the library/);
  assert.equal(button(), null);

  await act(async () => root.unmount());
  console.log('LegacySheetNotice: ok');
}

await main();
