// Run with: npx tsx src/components/layout/score/exportMenu.test.ts
import assert from 'node:assert/strict';
import {
  ALL_PARTS,
  buildExportMenu,
  MUSESCORE_DOWNLOAD_URL,
  routeFormatFor,
  SHEET_EXPORT_ORDER,
  type ExportMenuEntry,
} from './exportMenuModel.ts';
import type { NotationCapabilities } from '../../../lib/notationClient.ts';

const fullCaps: NotationCapabilities = {
  ok: true,
  music21: true,
  musescore: true,
  osmd_pdf: true,
  ffmpeg: true,
  engravers: { pdf: ['osmd', 'musescore'], svg: ['osmd', 'musescore'] },
  musescore_download_url: 'https://musescore.org/download',
  // The real list capabilities() returns (backend/modules/notation/engine.py):
  // "json" / "alphatex" are artifact kinds, never /export targets, and
  // "chordtrack" is its own caps["chords"] flag, not a formats entry. "midi"
  // is both an artifact kind and the sounding-pitch MIDI /export target.
  formats: ['musicxml', 'abc', 'notechart', 'beatsaber', 'midi', 'pdf', 'svg'],
  perform: true,
};

/** Neither engraver: no node, no MuseScore — pdf and svg are not listed. */
const noEngraverCaps: NotationCapabilities = {
  ...fullCaps,
  musescore: false,
  osmd_pdf: false,
  engravers: { pdf: [], svg: [] },
  formats: fullCaps.formats.filter((f) => f !== 'pdf' && f !== 'svg'),
};

const bandParts = [
  { name: 'Bass' },
  { name: 'Drums', isPercussion: true },
  { name: 'Keys' },
];

const FORMAT_IDS = ['xml', 'pack', ...SHEET_EXPORT_ORDER];
// All parts ends its formats with PERFORM; a single part does not offer it.
const ALL_IDS = [...FORMAT_IDS, 'perform'];
const ENGRAVER_IDS = ['get-musescore', 'locate-musescore'];

const ids = (entries: ExportMenuEntry[]) => entries.map((e) => e.id);
const byId = (entries: ExportMenuEntry[], id: string) => {
  const hit = entries.find((e) => e.id === id);
  assert.ok(hit, `entry ${id} present`);
  return hit;
};
const formatEntries = (entries: ExportMenuEntry[]) => entries.filter((e) => !ENGRAVER_IDS.includes(e.id));

// (a) Full capabilities + known parts: All parts first, then the score order;
// XML leads the format list, every format is enabled, and with both
// engravers present there is nothing to fetch or locate.
{
  const menu = buildExportMenu({ artifactKind: 'musicxml', caps: fullCaps, parts: bandParts });
  assert.deepEqual(menu.parts.map((p) => p.label), ['All parts', 'Bass', 'Drums', 'Keys']);
  assert.deepEqual(menu.parts.map((p) => p.index), [null, 0, 1, 2]);
  assert.equal(menu.parts[2].isPercussion, true);
  const all = menu.formatsFor(menu.parts[0]);
  assert.deepEqual(ids(all), ALL_IDS);
  assert.equal(all[0].id, 'xml');
  assert.ok(all.every((e) => e.enabled), 'every format enabled');
  assert.equal(byId(all, 'xml').kind, 'download');
  assert.equal(byId(all, 'pack').kind, 'download');
  assert.equal(byId(all, 'pdf').kind, 'export');
  assert.equal(byId(all, 'beatsaber').kind, 'popover');
  assert.ok(all.every((e) => e.partScoped === false), 'All parts is never part-scoped');
  assert.ok(byId(all, 'pack').title.includes('engraved on download'));
  // Either engraver draws PDF and SVG: OSMD first, MuseScore as the stand-in,
  // and the titles say so (the old "PDF never mentions MuseScore" rule is gone
  // with the old OSMD-only routing).
  for (const id of ['pdf', 'svg'] as const) {
    const t = byId(all, id).title;
    assert.ok(t.includes('OSMD') && t.includes('MuseScore') && t.includes('stands in'), t);
  }
  assert.ok(byId(all, 'pack').title.includes('MuseScore'), byId(all, 'pack').title);
  assert.equal(routeFormatFor(byId(all, 'pdf')), 'pdf');
}

// (b) Neither engraver: PDF and SVG stay in the list, disabled, each naming
// BOTH options and pointing at the two entries that follow the formats; the
// link carries the backend's download URL.
{
  const all = buildExportMenu({ artifactKind: 'musicxml', caps: noEngraverCaps, parts: bandParts }).formatsFor(ALL_PARTS);
  assert.deepEqual(ids(all), [...ALL_IDS, ...ENGRAVER_IDS]);
  for (const id of ['pdf', 'svg'] as const) {
    const e = byId(all, id);
    assert.equal(e.enabled, false, `${id} disabled without an engraver`);
    assert.ok(e.title.includes('OSMD') && e.title.includes('MuseScore'), e.title);
    assert.ok(e.title.includes('GET MUSESCORE') && e.title.includes('LOCATE MUSESCORE'), e.title);
  }
  assert.equal(byId(all, 'abc').enabled, true);
  assert.equal(byId(all, 'notechart').enabled, true);
  assert.equal(byId(all, 'beatsaber').enabled, true);
  const get = byId(all, 'get-musescore');
  assert.equal(get.kind, 'link');
  assert.equal(get.enabled, true);
  assert.equal(get.href, 'https://musescore.org/download');
  const locate = byId(all, 'locate-musescore');
  assert.equal(locate.kind, 'action');
  assert.equal(locate.enabled, true);
  assert.ok(locate.title.includes('Settings'), locate.title);
  // Without the backend's URL the link still goes somewhere real.
  const { musescore_download_url: _omit, ...capsNoUrl } = noEngraverCaps;
  void _omit;
  const noUrl = buildExportMenu({ artifactKind: 'musicxml', caps: capsNoUrl, parts: null }).formatsFor(ALL_PARTS);
  assert.equal(byId(noUrl, 'get-musescore').href, MUSESCORE_DOWNLOAD_URL);
  assert.equal(MUSESCORE_DOWNLOAD_URL, 'https://musescore.org/download');
}

// The two engraver entries appear when EITHER engraved format is missing,
// and never when both are offered (whatever the individual engine flags say).
{
  const svgOnly: NotationCapabilities = { ...fullCaps, formats: fullCaps.formats.filter((f) => f !== 'svg') };
  const all = buildExportMenu({ artifactKind: 'musicxml', caps: svgOnly, parts: null }).formatsFor(ALL_PARTS);
  assert.deepEqual(ids(all).slice(-2), ENGRAVER_IDS);
  const osmdOnly: NotationCapabilities = { ...fullCaps, musescore: false, engravers: { pdf: ['osmd'], svg: ['osmd'] } };
  assert.deepEqual(ids(buildExportMenu({ artifactKind: 'musicxml', caps: osmdOnly, parts: null }).formatsFor(ALL_PARTS)), ALL_IDS);
}

// A backend that does not list a chart format says so, without guessing.
{
  const caps: NotationCapabilities = { ...fullCaps, formats: fullCaps.formats.filter((f) => f !== 'notechart') };
  const all = buildExportMenu({ artifactKind: 'musicxml', caps, parts: null }).formatsFor(ALL_PARTS);
  const nc = byId(all, 'notechart');
  assert.equal(nc.enabled, false);
  assert.ok(nc.title.includes('not offered'), nc.title);
}

// (c) Capabilities not loaded yet: the downloads work, every export waits,
// and there is nothing to fetch or locate until the backend has spoken.
{
  const all = buildExportMenu({ artifactKind: 'musicxml', caps: null, parts: bandParts }).formatsFor(ALL_PARTS);
  assert.deepEqual(ids(all), ALL_IDS);
  assert.equal(byId(all, 'xml').enabled, true);
  assert.equal(byId(all, 'pack').enabled, true);
  for (const id of [...SHEET_EXPORT_ORDER, 'perform']) {
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

// (e) One pitched part: the same list as All parts, every entry enabled and
// part-scoped. XML is an export (the conversion that keeps one part), the
// pack is still a download (it takes ?parts=), the rest POST with the part,
// Beat Saber opens its popover on the part.
{
  const menu = buildExportMenu({ artifactKind: 'musicxml', caps: fullCaps, parts: bandParts });
  const bass = menu.formatsFor(menu.parts[1]);
  assert.deepEqual(ids(bass), FORMAT_IDS, 'same order as All parts');
  for (const e of bass) {
    assert.equal(e.enabled, true, `${e.id} enabled per part`);
    assert.equal(e.partScoped, true, `${e.id} part-scoped`);
    assert.ok(e.title.includes('Bass'), e.title);
  }
  const xml = byId(bass, 'xml');
  assert.equal(xml.kind, 'export');
  assert.equal(routeFormatFor(xml), 'musicxml');
  assert.equal(byId(bass, 'pack').kind, 'download');
  for (const id of ['pdf', 'abc', 'svg', 'notechart'] as const) {
    assert.equal(byId(bass, id).kind, 'export');
    assert.ok(byId(bass, id).title.includes('only'), byId(bass, id).title);
  }
  assert.equal(byId(bass, 'beatsaber').kind, 'popover');
  assert.ok(byId(bass, 'pdf').title.includes('OSMD') && byId(bass, 'pdf').title.includes('MuseScore'));
}

// (f) A percussion part: BEAT SABER is disabled with the reason, still
// part-scoped; every other format of that part exports as usual.
{
  const menu = buildExportMenu({ artifactKind: 'musicxml', caps: fullCaps, parts: bandParts });
  const drums = menu.formatsFor(menu.parts[2]);
  const bs = byId(drums, 'beatsaber');
  assert.equal(bs.enabled, false);
  assert.ok(bs.title.includes('Percussion'), bs.title);
  assert.equal(bs.partScoped, true);
  for (const e of drums) {
    if (e.id === 'beatsaber') continue;
    assert.equal(e.enabled, true, `${e.id} enabled for a percussion part`);
  }
}

// A per-part export still waits for capabilities like the rest; the pack
// (a download) does not.
{
  const menu = buildExportMenu({ artifactKind: 'musicxml', caps: null, parts: bandParts });
  const bass = menu.formatsFor(menu.parts[1]);
  assert.equal(byId(bass, 'pack').enabled, true);
  for (const e of bass) {
    if (e.id === 'pack') continue;
    assert.equal(e.enabled, false, `${e.id} waits for caps`);
    assert.ok(e.title.toLowerCase().includes('capabilities'), e.title);
  }
}

// Per part without an engraver: PDF/SVG disabled, GET/LOCATE follow.
{
  const menu = buildExportMenu({ artifactKind: 'musicxml', caps: noEngraverCaps, parts: bandParts });
  const bass = menu.formatsFor(menu.parts[1]);
  assert.deepEqual(ids(bass), [...FORMAT_IDS, ...ENGRAVER_IDS]);
  assert.equal(byId(bass, 'pdf').enabled, false);
  assert.ok(formatEntries(bass).every((e) => e.partScoped));
  assert.ok(ENGRAVER_IDS.every((id) => byId(bass, id).enabled && !byId(bass, id).partScoped));
}

// (h) A MIDI artifact: All parts only (no <part-list> to read, even when a
// part list is offered), and the sheet formats — XML is the conversion that
// makes the sheet, the pack is MIDI + PDF.
{
  const menu = buildExportMenu({ artifactKind: 'midi', caps: fullCaps, parts: bandParts });
  assert.deepEqual(menu.parts.map((p) => p.label), ['All parts']);
  const all = menu.formatsFor(menu.parts[0]);
  assert.deepEqual(ids(all), ALL_IDS);
  const xml = byId(all, 'xml');
  assert.equal(xml.kind, 'export');
  assert.equal(xml.enabled, true);
  assert.equal(routeFormatFor(xml), 'musicxml');
  assert.ok(xml.label.includes('sheet'), xml.label);
  const pack = byId(all, 'pack');
  assert.equal(pack.kind, 'download');
  assert.ok(pack.label.startsWith('MIDI'), pack.label);
  assert.ok(pack.title.startsWith('MIDI +'), pack.title);
  assert.ok(all.every((e) => e.partScoped === false));
  for (const id of SHEET_EXPORT_ORDER) assert.equal(byId(all, id).enabled, true, `${id} for a midi`);
  // Without caps the XML conversion waits like every other export.
  const pending = buildExportMenu({ artifactKind: 'midi', caps: null, parts: null }).formatsFor(ALL_PARTS);
  assert.equal(byId(pending, 'xml').enabled, false);
  assert.equal(byId(pending, 'pack').enabled, true);
}

// PERFORM: the whole sheet only, an 'export' entry the owner routes to
// POST /perform; a MIDI shows it disabled (make the sheet first), and a
// backend without partitura says so.
{
  const menu = buildExportMenu({ artifactKind: 'musicxml', caps: fullCaps, parts: bandParts });
  const perform = byId(menu.formatsFor(ALL_PARTS), 'perform');
  assert.equal(perform.kind, 'export');
  assert.equal(perform.enabled, true);
  assert.equal(perform.partScoped, false);
  assert.equal(perform.label, 'PERFORM (MIDI)');
  assert.equal(routeFormatFor(perform), 'perform');
  assert.ok(perform.title.includes('MIDI'), perform.title);
  for (const part of menu.parts.slice(1)) {
    assert.ok(!ids(menu.formatsFor(part)).includes('perform'), `no PERFORM for ${part.label}`);
  }

  const midi = byId(buildExportMenu({ artifactKind: 'midi', caps: fullCaps, parts: null }).formatsFor(ALL_PARTS), 'perform');
  assert.equal(midi.enabled, false);
  assert.ok(midi.title.includes('XML (sheet)'), midi.title);

  const noPartitura: NotationCapabilities = { ...fullCaps, perform: false };
  const missing = byId(buildExportMenu({ artifactKind: 'musicxml', caps: noPartitura, parts: null }).formatsFor(ALL_PARTS), 'perform');
  assert.equal(missing.enabled, false);
  assert.ok(missing.title.includes('partitura'), missing.title);

  // With no engraver, PERFORM still comes before GET / LOCATE MUSESCORE.
  const noEngraver = buildExportMenu({ artifactKind: 'musicxml', caps: noEngraverCaps, parts: null }).formatsFor(ALL_PARTS);
  assert.deepEqual(ids(noEngraver).slice(-3), ['perform', ...ENGRAVER_IDS]);
}

// (g) Anything that is not a sheet or a MIDI: All parts only, and one
// DOWNLOAD entry; with no artifact at all the download is disabled.
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

// MIDI at sounding pitch: offered after SVG for the whole sheet and for one
// part, exported through the route as 'midi', and its hover says what
// "sounding" means. A backend that does not list it says so.
{
  const menu = buildExportMenu({ artifactKind: 'musicxml', caps: fullCaps, parts: bandParts });
  const all = menu.formatsFor(ALL_PARTS);
  assert.deepEqual(ids(all).slice(4, 6), ['svg', 'midi']);
  const midi = byId(all, 'midi');
  assert.equal(midi.label, 'MIDI (SOUNDING)');
  assert.equal(midi.kind, 'export');
  assert.equal(midi.enabled, true);
  assert.equal(routeFormatFor(midi), 'midi');
  assert.ok(midi.title.includes('pitch it sounds') && midi.title.includes('tempo and meter'), midi.title);
  const bass = byId(menu.formatsFor(menu.parts[1]), 'midi');
  assert.equal(bass.partScoped, true);
  assert.ok(bass.title.includes('Bass only'), bass.title);
  const older: NotationCapabilities = { ...fullCaps, formats: fullCaps.formats.filter((f) => f !== 'midi') };
  const missing = byId(buildExportMenu({ artifactKind: 'musicxml', caps: older, parts: null }).formatsFor(ALL_PARTS), 'midi');
  assert.equal(missing.enabled, false);
  assert.ok(missing.title.includes('not offered'), missing.title);
}

// A nameless part gets a positional label.
{
  const menu = buildExportMenu({ artifactKind: 'musicxml', caps: fullCaps, parts: [{ name: '' }, { name: 'Lead' }] });
  assert.deepEqual(menu.parts.map((p) => p.label), ['All parts', 'Part 1', 'Lead']);
}

console.log('exportMenu tests passed');
