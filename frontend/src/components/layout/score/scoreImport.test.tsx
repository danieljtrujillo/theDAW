/**
 * IMPORT SCORE FILE and BROWSE CORPUS on the SCORE rail.
 *
 * The model: the picker takes what POST /api/notation/import takes (the
 * backend's own list once capabilities have come), a file is refused before
 * it is sent when its type, emptiness or size rules it out, a corpus query is
 * searched from two letters, a result row reads title first, and the arrow
 * keys move the listbox's active row within it.
 *
 * The markup: the file input has a real <label htmlFor>, the BROWSE CORPUS
 * key says it opens a dialog, the dialog's search field is labelled and
 * drives a role="listbox" of role="option" rows, and no text is set below
 * 12px (text-xs).
 *
 * Run: `npx tsx src/components/layout/score/scoreImport.test.tsx`
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CorpusPiece, NotationCapabilities } from '../../../lib/notationClient';
import {
  acceptAttribute,
  corpusQuery,
  corpusRow,
  importExtensions,
  importRefusal,
  isImportableScoreName,
  nextActiveIndex,
  resultsSummary,
  SCORE_IMPORT_EXTENSIONS,
} from './scoreImportModel';

const caps = (extra: Partial<NotationCapabilities> = {}): NotationCapabilities => ({
  ok: true,
  music21: true,
  musescore: false,
  formats: ['musicxml', 'abc', 'notechart', 'beatsaber', 'midi'],
  score_import: { extensions: ['.musicxml', '.xml', '.mxl', '.krn', '.abc'], max_bytes: 25 * 1024 * 1024, corpus: true },
  ...extra,
});

// ---- the model -------------------------------------------------------------

// What the picker takes: the backend's list, else the same five.
assert.deepEqual([...SCORE_IMPORT_EXTENSIONS], ['.musicxml', '.xml', '.mxl', '.krn', '.abc']);
assert.deepEqual(importExtensions(null), [...SCORE_IMPORT_EXTENSIONS]);
assert.equal(acceptAttribute(caps()), '.musicxml,.xml,.mxl,.krn,.abc');
assert.deepEqual(
  importExtensions(caps({ score_import: { extensions: ['.MXL'], max_bytes: 10, corpus: false } })),
  ['.mxl'],
);
for (const name of ['Bach.musicxml', 'x.XML', 'chorale.mxl', 'tune.krn', 'jig.abc']) {
  assert.equal(isImportableScoreName(name), true, name);
}
for (const name of ['song.mid', 'take.wav', 'notes.txt', 'musicxml']) {
  assert.equal(isImportableScoreName(name), false, name);
}

// A file is refused before it is sent, with the reason.
assert.match(importRefusal({ name: 'take.wav', size: 10 }, caps()) ?? '', /not a score file.*\.musicxml, \.xml, \.mxl, \.krn, \.abc/);
assert.match(importRefusal({ name: 'empty.abc', size: 0 }, caps()) ?? '', /empty/);
assert.match(importRefusal({ name: 'huge.mxl', size: 26 * 1024 * 1024 }, caps()) ?? '', /larger than 25 MB/);
assert.equal(importRefusal({ name: 'ok.mxl', size: 2048 }, caps()), null);
// Before capabilities arrive the size is left to the backend.
assert.equal(importRefusal({ name: 'huge.mxl', size: 26 * 1024 * 1024 }, null), null);

// A query is searched from two letters, whitespace collapsed.
assert.equal(corpusQuery(''), null);
assert.equal(corpusQuery(' b '), null);
assert.equal(corpusQuery('  bach   chorale '), 'bach chorale');

// A row reads title first, then movement, composer and part count.
const piece = (extra: Partial<CorpusPiece>): CorpusPiece => ({
  id: 'bach_bwv66_6_mxl',
  composer: 'J.S. Bach',
  title: 'bwv66.6',
  movement: '',
  parts: 4,
  path: 'bach/bwv66.6.mxl',
  ...extra,
});
assert.deepEqual(corpusRow(piece({})), {
  id: 'bach_bwv66_6_mxl',
  primary: 'bwv66.6',
  secondary: 'J.S. Bach · 4 parts',
  label: 'bwv66.6, J.S. Bach · 4 parts, bach/bwv66.6.mxl',
});
assert.equal(corpusRow(piece({ composer: '', parts: 1, movement: 'Kyrie' })).secondary, 'Kyrie · Composer unknown · 1 part');
assert.equal(corpusRow(piece({ title: '' })).primary, 'bach/bwv66.6.mxl');

// The arrow keys stay inside the list; other keys do not move it.
assert.equal(nextActiveIndex('ArrowDown', -1, 3), 0);
assert.equal(nextActiveIndex('ArrowDown', 2, 3), 2);
assert.equal(nextActiveIndex('ArrowUp', 0, 3), 0);
assert.equal(nextActiveIndex('ArrowUp', -1, 3), 2);
assert.equal(nextActiveIndex('Home', 2, 3), 0);
assert.equal(nextActiveIndex('End', 0, 3), 2);
assert.equal(nextActiveIndex('PageDown', 0, 30), 10);
assert.equal(nextActiveIndex('PageUp', 5, 30), 0);
assert.equal(nextActiveIndex('Enter', 1, 3), null);
assert.equal(nextActiveIndex('ArrowDown', 0, 0), null);

// The line under the list says what happened.
assert.match(resultsSummary(null, 0, 0, false), /2 or more letters/);
assert.match(resultsSummary('bach', 0, 0, true), /Searching for “bach”/);
assert.match(resultsSummary('zzz', 0, 0, false), /Nothing in the corpus matches “zzz”/);
assert.equal(resultsSummary('bach', 1, 1, false), '1 piece matches.');
assert.equal(resultsSummary('bach', 564, 100, false), '564 pieces match; the first 100 are listed.');

// ---- the markup ------------------------------------------------------------

const { ScoreImport, CorpusDialog } = await import('./ScoreImport.tsx');

const rail = renderToStaticMarkup(React.createElement(ScoreImport, { caps: caps(), onImported: () => {} }));
const fileInput = /<input[^>]*type="file"[^>]*>/.exec(rail)?.[0] ?? '';
const inputId = /id="([^"]+)"/.exec(fileInput)?.[1] ?? '';
assert.ok(inputId, 'the file input has an id');
assert.match(fileInput, /name="score-import-file"/);
assert.match(fileInput, /accept="\.musicxml,\.xml,\.mxl,\.krn,\.abc"/);
assert.ok(rail.includes(`<label for="${inputId}"`), 'a real label points at the file input');
assert.match(rail, />Import score file</);
const browse = /<button[^>]*aria-haspopup="dialog"[^>]*>/.exec(rail)?.[0] ?? '';
assert.match(browse, /aria-expanded="false"/, 'BROWSE CORPUS says it opens a dialog, closed');
assert.match(rail, />Browse corpus</);
// No corpus on this backend: the key is disabled and says why.
const noCorpus = renderToStaticMarkup(
  React.createElement(ScoreImport, {
    caps: caps({ score_import: { extensions: ['.abc'], max_bytes: 10, corpus: false } }),
    onImported: () => {},
  }),
);
assert.match(/<button[^>]*aria-haspopup="dialog"[^>]*>/.exec(noCorpus)?.[0] ?? '', /disabled=""/);

const dialog = renderToStaticMarkup(React.createElement(CorpusDialog, { id: 'corpus', onClose: () => {}, onImported: () => {} }));
assert.match(dialog, /role="dialog"/);
assert.match(dialog, /aria-modal="true"/);
const heading = /<h2 id="([^"]+)"/.exec(dialog)?.[1] ?? '';
assert.ok(dialog.includes(`aria-labelledby="${heading}"`), 'the dialog is named by its heading');
const search = /<input[^>]*type="search"[^>]*>/.exec(dialog)?.[0] ?? '';
const searchId = /id="([^"]+)"/.exec(search)?.[1] ?? '';
assert.ok(searchId && dialog.includes(`<label for="${searchId}"`), 'the search field has a real label');
assert.match(search, /name="score-corpus-search"/);
assert.match(search, /role="combobox"/);
const listbox = /<div[^>]*role="listbox"[^>]*>/.exec(dialog)?.[0] ?? '';
const listId = /id="([^"]+)"/.exec(listbox)?.[1] ?? '';
assert.ok(listId && search.includes(`aria-controls="${listId}"`), 'the field drives the listbox');
assert.match(listbox, /aria-labelledby="/);
// Open waits for a chosen piece.
assert.match(/<button[^>]*>(?:(?!<\/button>).)*Open<\/button>/s.exec(dialog)?.[0] ?? '', /disabled=""/);

// Nothing on either surface is set below 12px.
for (const html of [rail, dialog]) {
  assert.ok(!/text-\[(?:[0-9]|1[01])px\]/.test(html), 'no text below 12px');
  assert.ok(!/text-\[(?:0\.[0-6]\d*)rem\]/.test(html), 'no text below 12px');
}

// ---- the sequence ----------------------------------------------------------
// Typing searches the corpus after the pause, the first result is active,
// ArrowDown moves to the next, Enter opens it and hands the composition on;
// Escape closes. A picked file posts to /import; a .wav is refused unsent.

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'File', 'FormData', 'getComputedStyle']) {
  Object.defineProperty(g, key, { value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true, writable: true });
}
g.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import('react-dom/client');
const { act } = React;

const bach = (id: string, title: string): CorpusPiece => ({ id, composer: 'J.S. Bach', title, movement: '', parts: 4, path: `bach/${title}.mxl` });
const answer = (id: string, title: string) => ({
  ok: true,
  entry_id: `entry-${id}`,
  title,
  composer: 'J.S. Bach',
  sheet: null,
  artifacts: [],
});
const calls: string[] = [];
globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const u = String(url);
  calls.push(`${init?.method ?? 'GET'} ${u}${typeof init?.body === 'string' ? ` ${init.body}` : ''}`);
  if (u.startsWith('/api/notation/corpus?')) {
    return new Response(JSON.stringify({ query: 'bach', total: 2, results: [bach('bach_a', 'bwv1.6'), bach('bach_b', 'bwv10.7')] }), { status: 200 });
  }
  if (u === '/api/notation/corpus/open') return new Response(JSON.stringify(answer('bach_b', 'bwv10.7')), { status: 200 });
  if (u === '/api/notation/import') return new Response(JSON.stringify(answer('file', 'Clarinet Study')), { status: 200 });
  return new Response('{}', { status: 404 });
}) as typeof fetch;

const host = dom.window.document.getElementById('root')!;
const root = createRoot(host);
const imported: string[] = [];
let closed = 0;
await act(async () => {
  root.render(React.createElement(CorpusDialog, {
    id: 'corpus',
    onClose: () => { closed += 1; },
    onImported: (r: { entry_id: string }) => { imported.push(r.entry_id); },
  }));
});
const doc = dom.window.document;
const field = doc.querySelector('input[type="search"]') as HTMLInputElement;
assert.equal(doc.activeElement, field, 'the search field has focus when the dialog opens');
const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
await act(async () => {
  setValue.call(field, 'bach');
  field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
});
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 400));
});
assert.deepEqual(calls, ['GET /api/notation/corpus?q=bach&limit=100']);
const options = () => Array.from(doc.querySelectorAll('[role="option"]')) as HTMLElement[];
assert.equal(options().length, 2);
assert.equal(options()[0].getAttribute('aria-selected'), 'true');
assert.equal(field.getAttribute('aria-activedescendant'), options()[0].id);
assert.match(doc.querySelector('[role="status"]')?.textContent ?? '', /2 pieces match/);
const key = (k: string) => act(async () => {
  field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
});
await key('ArrowDown');
assert.equal(options()[1].getAttribute('aria-selected'), 'true');
assert.equal(field.getAttribute('aria-activedescendant'), options()[1].id);
await key('Enter');
assert.equal(calls.at(-1), 'POST /api/notation/corpus/open {"id":"bach_b"}');
assert.deepEqual(imported, ['entry-bach_b']);
await key('Escape');
assert.equal(closed, 1);
await act(async () => root.unmount());

// IMPORT SCORE FILE: a score file posts; a .wav never leaves the machine.
const railRoot = createRoot(host);
const handed: string[] = [];
await act(async () => {
  railRoot.render(React.createElement(ScoreImport, { caps: caps(), onImported: (r: { entry_id: string }) => { handed.push(r.entry_id); } }));
});
const fileInput2 = doc.querySelector('input[type="file"]') as HTMLInputElement;
const pick = (file: File) => act(async () => {
  Object.defineProperty(fileInput2, 'files', { value: [file], configurable: true });
  fileInput2.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
});
calls.length = 0;
await pick(new dom.window.File(['RIFF'], 'take.wav'));
assert.deepEqual(calls, [], 'a .wav is refused before it is sent');
assert.match(doc.querySelector('[role="status"]')?.textContent ?? '', /take\.wav is not a score file/);
await pick(new dom.window.File(['X:1\nT:t\nK:C\nC|'], 'jig.abc'));
assert.deepEqual(calls.map((c) => c.split(' ').slice(0, 2).join(' ')), ['POST /api/notation/import']);
assert.deepEqual(handed, ['entry-file']);
assert.match(doc.querySelector('[role="status"]')?.textContent ?? '', /Imported Clarinet Study/);
await act(async () => railRoot.unmount());

console.log('scoreImport: ok');
