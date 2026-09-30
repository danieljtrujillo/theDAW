/**
 * T26 SCORE UI — withPartNamesOnEverySystem (ScoreView.tsx).
 *
 * OSMD only ever builds a part-name label for the very first system of the
 * WHOLE piece; every later system is unlabelled unless the source XML
 * carries a <part-abbreviation>, in which case OSMD prints THAT — never the
 * full name — there. A multi-part chart is unreadable past the first system
 * without a name on it, so ScoreView copies each part's full name into its
 * own <part-abbreviation> before OSMD ever sees the XML.
 *
 * jsdom, same reasoning as HfTokenField.b12.test.tsx: ScoreView.tsx reads
 * localStorage at module scope (the fit-zoom cache) and the function under
 * test itself uses DOMParser/XMLSerializer, none of which plain Node has.
 *
 * Run: cd frontend && npx tsx src/components/layout/ScoreView.b12.test.ts
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;

// Deliberately NOT `window`/`document`/`localStorage` as bare globals: several
// stores ScoreView.tsx pulls in (e.g. playerStore.ts) guard their module-scope
// setup with `typeof window !== 'undefined'` specifically so a non-browser
// import (this test) is a no-op instead of a crash — giving them a `window`
// only trips that guard into code that then reads `import.meta.env`, which
// plain tsx (no Vite) never populates. DOMParser/XMLSerializer are all the
// function under test actually needs, and it is guarded by try/catch besides.
const globals: Record<string, unknown> = {
  DOMParser: win.DOMParser,
  XMLSerializer: win.XMLSerializer,
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const { withPartNamesOnEverySystem, ensureXmlDeclaration } = await import('./ScoreView.tsx');

const twoPartXml =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<score-partwise version="4.0">' +
  '<part-list>' +
  '<score-part id="P1"><part-name>Violin</part-name></score-part>' +
  '<score-part id="P2"><part-name>Cello</part-name><part-abbreviation>Vc.</part-abbreviation></score-part>' +
  '</part-list>' +
  '<part id="P1"><measure number="1"/></part>' +
  '<part id="P2"><measure number="1"/></part>' +
  '</score-partwise>';

// A part with no <part-abbreviation> at all gets one, set to its full name —
// the system-2+ label OSMD draws from part-abbreviation is then the name.
{
  const out = withPartNamesOnEverySystem(twoPartXml);
  const doc = new win.DOMParser().parseFromString(out, 'application/xml');
  assert.equal(doc.querySelector('parsererror'), null, 'the rewritten XML still parses');
  const p1 = doc.querySelector('score-part[id="P1"]');
  assert.equal(p1?.querySelector('part-abbreviation')?.textContent, 'Violin', 'P1 gets an abbreviation = its full name');
}

// A part that already HAD a (different, shorter) abbreviation gets it
// overwritten too: the feature is full names on every system, not whatever
// abbreviation the source happened to carry.
{
  const out = withPartNamesOnEverySystem(twoPartXml);
  const doc = new win.DOMParser().parseFromString(out, 'application/xml');
  const p2 = doc.querySelector('score-part[id="P2"]');
  assert.equal(p2?.querySelector('part-abbreviation')?.textContent, 'Cello', 'P2’s "Vc." is replaced by the full name');
  // Exactly one <part-abbreviation> per part — the original element is
  // reused, not duplicated alongside a new one.
  assert.equal(p2?.querySelectorAll('part-abbreviation').length, 1);
}

// A single-part score is left alone. Not because OSMD is unable to label a
// lone part — its own gate counts STAFF LINES, not parts, so a solo grand
// staff (two staff lines, one part) could get one — but because there is
// only one part in the piece, so naming it disambiguates nothing.
{
  const onePartXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<score-partwise version="4.0">' +
    '<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>' +
    '<part id="P1"><measure number="1"/></part>' +
    '</score-partwise>';
  assert.equal(withPartNamesOnEverySystem(onePartXml), onePartXml);
}

// A part with a <part-name-display> gets its new <part-abbreviation> placed
// right after it (MusicXML order: part-name, part-name-display?, part-
// abbreviation?, part-abbreviation-display?), not spliced in right after
// part-name where it would land BEFORE part-name-display.
{
  const withDisplayXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<score-partwise version="4.0">' +
    '<part-list>' +
    '<score-part id="P1">' +
    '<part-name>Violin</part-name>' +
    '<part-name-display><display-text>Violin</display-text></part-name-display>' +
    '</score-part>' +
    '<score-part id="P2"><part-name>Cello</part-name></score-part>' +
    '</part-list>' +
    '<part id="P1"><measure number="1"/></part>' +
    '<part id="P2"><measure number="1"/></part>' +
    '</score-partwise>';
  const out = withPartNamesOnEverySystem(withDisplayXml);
  const doc = new win.DOMParser().parseFromString(out, 'application/xml');
  const p1 = doc.querySelector('score-part[id="P1"]');
  const kids = Array.from(p1?.children ?? []).map((el: Element) => el.tagName);
  assert.deepEqual(kids, ['part-name', 'part-name-display', 'part-abbreviation'], 'abbreviation lands after part-name-display, not before it');
  assert.equal(p1?.querySelector('part-abbreviation')?.textContent, 'Violin');
}

// Malformed XML: returned unchanged rather than throwing (OSMD then gets the
// same input it always got, and the caller's own error handling reports it).
{
  const broken = '<score-partwise><part-list>';
  assert.equal(withPartNamesOnEverySystem(broken), broken);
}

// jsdom's XMLSerializer drops the leading <?xml ...?> declaration, and OSMD
// 1.9.9's load() rejects input that doesn't start with one — the output must
// always start with a declaration regardless of what the serializer did.
{
  const out = withPartNamesOnEverySystem(twoPartXml);
  assert.ok(out.startsWith('<?xml'), `output must start with an XML declaration, got: ${out.slice(0, 40)}`);
}

// ensureXmlDeclaration, tested directly (not through the serializer, whose
// jsdom behaviour is a fact about the test environment, not about this
// logic): adds a declaration when missing, never doubles one already there.
{
  assert.equal(ensureXmlDeclaration('<foo/>'), '<?xml version="1.0" encoding="UTF-8"?>\n<foo/>');
  const alreadyDeclared = '<?xml version="1.0" encoding="UTF-8"?><foo/>';
  assert.equal(ensureXmlDeclaration(alreadyDeclared), alreadyDeclared, 'an existing declaration is not doubled');
}

console.log('ScoreView: withPartNamesOnEverySystem writes full part names onto every part’s abbreviation slot');
