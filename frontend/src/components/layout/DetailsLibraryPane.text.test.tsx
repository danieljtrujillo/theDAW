/**
 * Render test for the DETAILS library pane's toolbar text (node, no DOM:
 * `renderToStaticMarkup`).
 *
 * What it pins: every control a user reads in the pane's toolbar is bold sans
 * at 12 px (`text-xs font-bold`), with no mono face and no size under 12 px.
 * That is the count, the IMPORT button, the search field (the text typed into
 * it) and the sort select, plus the empty-list message. The search field was
 * the one left at the regular weight when the rest moved to bold sans.
 *
 *   cd frontend && npx tsx src/components/layout/DetailsLibraryPane.text.test.tsx
 */
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DetailsLibraryPane } from './DetailsLibraryPane.tsx';

const html = renderToStaticMarkup(<DetailsLibraryPane />);

/** The class attribute of the first element whose opening tag matches `tag`. */
function classOf(tag: RegExp, what: string): string {
  const open = tag.exec(html)?.[0];
  assert.ok(open, `${what} is rendered`);
  const cls = /class="([^"]*)"/.exec(open)?.[1];
  assert.ok(cls, `${what} has a class`);
  return cls;
}

function assertBoldSans12(cls: string, what: string): void {
  const words = cls.split(/\s+/);
  assert.ok(words.includes('text-xs'), `${what} is 12 px: ${cls}`);
  assert.ok(words.includes('font-bold'), `${what} is bold: ${cls}`);
  assert.ok(!words.includes('font-mono'), `${what} is sans: ${cls}`);
}

assertBoldSans12(classOf(/<input[^>]*id="details-library-filter"[^>]*>/, 'the search field'), 'the search field');
assertBoldSans12(classOf(/<select[^>]*id="details-library-sort"[^>]*>/, 'the sort select'), 'the sort select');
assertBoldSans12(classOf(/<button[^>]*title="Import audio files[^"]*"[^>]*>/, 'the IMPORT button'), 'the IMPORT button');
assertBoldSans12(classOf(/<span[^>]*class="[^"]*"[^>]*>(?=<svg[^>]*lucide-library)/, 'the count'), 'the count');
assert.ok(html.includes('0 tracks'), 'the count reads the library total');

// The empty list's message, in the same face.
{
  const p = /<p class="([^"]*)">[^<]*<\/p>/.exec(html);
  assert.ok(p, 'the empty list shows a message');
  assertBoldSans12(p[1], 'the empty-list message');
}

// Nothing in the pane is under 12 px or in a mono face.
assert.ok(!/text-\[(?:[0-9]|1[01])(?:\.[0-9]+)?px\]/.test(html), 'no text under 12 px');
assert.ok(!/\bfont-mono\b/.test(html), 'no mono labels');

console.log('DetailsLibraryPane text: all assertions passed');
