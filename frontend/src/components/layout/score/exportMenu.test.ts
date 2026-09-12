// Run with: npx tsx src/components/layout/score/exportMenu.test.ts
import assert from 'node:assert/strict';
import { ALL_PARTS, buildExportMenu, SHEET_EXPORT_ORDER, type ExportMenuEntry } from './exportMenuModel.ts';
import type { NotationCapabilities } from '../../../lib/notationClient.ts';

const fullCaps: NotationCapabilities = {
  ok: true,
  music21: true,
  musescore: true,
  osmd_pdf: true,
  ffmpeg: true,
  formats: ['midi', 'musicxml', 'abc', 'json', 'alphatex', 'notechart', 'beatsaber', 'chordtrack', 'pdf', 'svg'],
};

const bandParts = [
  { name: 'Bass' },
  { name: 'Drums', isPercussion: true },
  { name: 'Keys' },
];

const ids = (entries: ExportMenuEntry[]) => entries.map((e) => e.id);
const byId = (entries: ExportMenuEntry[], id: string) => {
  const hit = entries.find((e) => e.id === id);
  assert.ok(hit, `entry ${id} present`);
  return hit;
};

// (a) Full capabilities + known parts: All parts first, then the score order;
// XML leads the format list and every format is enabled.
{
  const menu = buildExportMenu({ artifactKind: 'musicxml', caps: fullCaps, parts: bandParts });
  assert.deepEqual(menu.parts.map((p) => p.label), ['All parts', 'Bass', 'Drums', 'Keys']);
  assert.deepEqual(menu.parts.map((p) => p.index), [null, 0, 1, 2]);
  assert.equal(menu.parts[2].isPercussion, true);
  const all = menu.formatsFor(menu.parts[0]);
  assert.deepEqual(ids(all), ['xml', 'pack', ...SHEET_EXPORT_ORDER]);
  assert.equal(all[0].id, 'xml');
  assert.ok(all.every((e) => e.enabled), 'every format enabled');
  assert.equal(byId(all, 'xml').kind, 'download');
  assert.equal(byId(all, 'pack').kind, 'download');
  assert.equal(byId(all, 'pdf').kind, 'export');
  assert.equal(byId(all, 'beatsaber').kind, 'popover');
  assert.ok(all.every((e) => e.partScoped === false), 'All parts is never part-scoped');
  assert.ok(byId(all, 'pack').title.includes('engraved on download'));
}

// (b) Without MuseScore and without the OSMD renderer: PDF and SVG stay in
// the list, disabled, each naming what it needs; the order does not change.
{
  const caps: NotationCapabilities = { ...fullCaps, musescore: false, osmd_pdf: false, formats: fullCaps.formats.filter((f) => f !== 'pdf' && f !== 'svg') };
  const all = buildExportMenu({ artifactKind: 'musicxml', caps, parts: bandParts }).formatsFor(ALL_PARTS);
  assert.deepEqual(ids(all), ['xml', 'pack', ...SHEET_EXPORT_ORDER]);
  const pdf = byId(all, 'pdf');
  const svg = byId(all, 'svg');
  assert.equal(pdf.enabled, false);
  assert.equal(svg.enabled, false);
  assert.ok(pdf.title.includes('MuseScore') && pdf.title.includes('OSMD'), pdf.title);
  assert.ok(svg.title.includes('MuseScore'), svg.title);
  assert.equal(byId(all, 'abc').enabled, true);
  assert.equal(byId(all, 'notechart').enabled, true);
  assert.equal(byId(all, 'beatsaber').enabled, true);
}

// A backend that does not list a chart format says so, without guessing.
{
  const caps: NotationCapabilities = { ...fullCaps, formats: fullCaps.formats.filter((f) => f !== 'notechart') };
  const all = buildExportMenu({ artifactKind: 'musicxml', caps, parts: null }).formatsFor(ALL_PARTS);
  const nc = byId(all, 'notechart');
  assert.equal(nc.enabled, false);
  assert.ok(nc.title.includes('not offered'), nc.title);
}

// (c) Capabilities not loaded yet: the downloads work, every export waits.
{
  const all = buildExportMenu({ artifactKind: 'musicxml', caps: null, parts: bandParts }).formatsFor(ALL_PARTS);
  assert.equal(byId(all, 'xml').enabled, true);
  assert.equal(byId(all, 'pack').enabled, true);
  for (const id of SHEET_EXPORT_ORDER) {
    const e = byId(all, id);
    assert.equal(e.enabled, false, `${id} disabled without caps`);
    assert.ok(e.title.toLowerCase().includes('capabilities'), e.title);
  }
}

// (d) Parts unknown (nothing has loaded the sheet): only All parts.
{
  const menu = buildExportMenu({ artifactKind: 'musicxml', caps: fullCaps, parts: null });
  assert.deepEqual(menu.parts.map((p) => p.label), ['All parts']);
  assert.deepEqual(menu.parts[0], ALL_PARTS);
}

// (e) One pitched part: only BEAT SABER exports a single part (the only
// converter that reads options.parts); everything else is disabled and
// points at All parts.
{
  const menu = buildExportMenu({ artifactKind: 'musicxml', caps: fullCaps, parts: bandParts });
  const bass = menu.formatsFor(menu.parts[1]);
  assert.deepEqual(ids(bass), ['xml', 'pack', ...SHEET_EXPORT_ORDER], 'same order as All parts');
  const bs = byId(bass, 'beatsaber');
  assert.equal(bs.enabled, true);
  assert.equal(bs.partScoped, true);
  assert.ok(bs.title.includes('Bass'), bs.title);
  for (const e of bass) {
    if (e.id === 'beatsaber') continue;
    assert.equal(e.enabled, false, `${e.id} disabled per part`);
    assert.equal(e.partScoped, false);
    assert.ok(e.title.includes('All parts'), e.title);
  }
  assert.ok(byId(bass, 'pdf').title.includes('no part filter'));
}

// (f) A percussion part: BEAT SABER is disabled with the reason.
{
  const menu = buildExportMenu({ artifactKind: 'musicxml', caps: fullCaps, parts: bandParts });
  const drums = byId(menu.formatsFor(menu.parts[2]), 'beatsaber');
  assert.equal(drums.enabled, false);
  assert.ok(drums.title.includes('Percussion'), drums.title);
  assert.equal(drums.partScoped, true);
}

// A per-part BEAT SABER entry still waits for capabilities like the rest.
{
  const menu = buildExportMenu({ artifactKind: 'musicxml', caps: null, parts: bandParts });
  const bs = byId(menu.formatsFor(menu.parts[1]), 'beatsaber');
  assert.equal(bs.enabled, false);
  assert.ok(bs.title.toLowerCase().includes('capabilities'), bs.title);
}

// (g) Anything that is not a sheet: All parts only, and one DOWNLOAD entry;
// with no artifact at all the download is disabled.
{
  const pdfMenu = buildExportMenu({ artifactKind: 'pdf', caps: fullCaps, parts: bandParts });
  assert.deepEqual(pdfMenu.parts.map((p) => p.label), ['All parts']);
  const formats = pdfMenu.formatsFor(pdfMenu.parts[0]);
  assert.deepEqual(ids(formats), ['file']);
  assert.equal(formats[0].label, 'DOWNLOAD');
  assert.equal(formats[0].kind, 'download');
  assert.equal(formats[0].enabled, true);

  const none = buildExportMenu({ artifactKind: null, caps: fullCaps, parts: null });
  assert.deepEqual(none.parts.map((p) => p.label), ['All parts']);
  const noneFormats = none.formatsFor(none.parts[0]);
  assert.deepEqual(ids(noneFormats), ['file']);
  assert.equal(noneFormats[0].enabled, false);
}

// A nameless part gets a positional label.
{
  const menu = buildExportMenu({ artifactKind: 'musicxml', caps: fullCaps, parts: [{ name: '' }, { name: 'Lead' }] });
  assert.deepEqual(menu.parts.map((p) => p.label), ['All parts', 'Part 1', 'Lead']);
}

console.log('exportMenu tests passed');
