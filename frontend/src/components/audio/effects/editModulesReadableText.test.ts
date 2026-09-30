/**
 * Readable text and notice placement on the two Edit Tool Stack pages this
 * round edited (frontend/public/edit-modules/tool.html and enhance.html).
 *
 *   - Every font declaration in the page (its <style>, inline styles and the
 *     canvas placeholder's ctx.font) is 12 px or larger and in the sans face:
 *     no text under 12 px, no mono labels. The pages had 7-11 px IBM Plex
 *     Mono pills, labels, values and footer buttons beside the 12 px notices.
 *   - The swr notice (#noteBar) sits above the controls on both pages:
 *     tool.html above the monitor and the controls, enhance.html under the
 *     tool pills and above the spectrogram and the control strip. On
 *     enhance.html it used to come after the control strip, above the footer.
 *   - Every button on enhance.html has an accessible name, and the MIX slider
 *     has a real <label for>.
 *
 * Run with:  npx tsx src/components/audio/effects/editModulesReadableText.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = join(here, '..', '..', '..', '..', 'public', 'edit-modules');
const read = (file: string) => readFileSync(join(MODULES_DIR, file), 'utf8');

const MIN_PX = 12;

/** Every `font:` / `font-size:` declaration value in the file, CSS or inline. */
function fontDeclarations(src: string): string[] {
  return [...src.matchAll(/font(?:-size)?\s*:\s*([^;"'}]+)/g)].map((m) => m[1].trim());
}

/** Every `ctx.font = '...'` the page's canvas code assigns. */
function canvasFonts(src: string): string[] {
  return [...src.matchAll(/\.font\s*=\s*(['"`])((?:(?!\1).)+)\1/g)].map((m) => m[2]);
}

function assertReadable(value: string, where: string): void {
  const px = /(\d+(?:\.\d+)?)px/.exec(value);
  assert.ok(px, `${where}: a font with no px size (${value})`);
  assert.ok(Number(px[1]) >= MIN_PX, `${where}: ${px[1]} px is under ${MIN_PX} px (${value})`);
  assert.ok(!/mono/i.test(value), `${where}: a mono face (${value})`);
}

for (const file of ['tool.html', 'enhance.html']) {
  const src = read(file);
  const decls = fontDeclarations(src);
  assert.ok(decls.length > 10, `${file}: the font declarations were found (${decls.length})`);
  for (const value of decls) assertReadable(value, file);
  const canvas = canvasFonts(src);
  assert.ok(canvas.length > 0, `${file}: the canvas placeholder's font was found`);
  for (const value of canvas) assertReadable(value, `${file} canvas`);
}

/** The page's markup: everything before its first script tag, so the
 *  script's own strings (tool.html builds its controls from templates) are
 *  not read as elements. */
function markup(src: string): string {
  const end = src.indexOf('<script');
  return end < 0 ? src : src.slice(0, end);
}

/** Where the one element with this id starts in the markup. */
function at(html: string, id: string): number {
  const pos = html.indexOf(`id="${id}"`);
  assert.ok(pos >= 0, `#${id} exists`);
  assert.equal(html.indexOf(`id="${id}"`, pos + 1), -1, `#${id} is unique`);
  return pos;
}

/** A button's accessible name: its aria-label, else its text. */
function buttonName(attrs: string, inner: string): string {
  const label = /aria-label="([^"]*)"/.exec(attrs)?.[1]?.trim();
  if (label) return label;
  return inner
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .trim();
}

/* ── tool.html: the notice above the monitor and the controls ────────────── */
{
  const html = markup(read('tool.html'));
  assert.ok(at(html, 'naBar') < at(html, 'noteBar'), 'tool.html: the unavailable bar, then the notice');
  assert.ok(at(html, 'noteBar') < at(html, 'vizZone'), 'tool.html: the notice is above the monitor');
  assert.ok(at(html, 'noteBar') < at(html, 'controls'), 'tool.html: the notice is above the controls');
}

/* ── enhance.html: the notice under the tool pills, above everything else ── */
{
  const html = markup(read('enhance.html'));
  const modeBar = html.indexOf('class="mode-bar"');
  assert.ok(modeBar >= 0, 'enhance.html: the tool pills');
  const note = at(html, 'noteBar');
  assert.ok(modeBar < note, 'enhance.html: the notice comes after the tool pills');
  assert.ok(note < at(html, 'spectArea'), 'enhance.html: the notice is above the spectrogram');
  assert.ok(note < at(html, 'ctrlStrip'), 'enhance.html: the notice is above the controls');
  assert.match(html, /<div class="note-bar" id="noteBar" role="status" hidden><\/div>/, 'the notice is a status');

  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  assert.ok(buttons.length > 10, `enhance.html: its buttons were found (${buttons.length})`);
  for (const [whole, attrs, inner] of buttons) {
    const name = buttonName(attrs, inner);
    // A lone arrow glyph (U+25A0..U+25FF) reads as "black left-pointing
    // small triangle", not as what the button does.
    assert.ok(name && !/^[\u25a0-\u25ff]+$/u.test(name), `enhance.html: a button with no accessible name (${whole.slice(0, 80)})`);
  }
  assert.ok(html.includes('id="mixSlider"'), 'the MIX slider');
  assert.match(html, /<label[^>]*\bfor="mixSlider"/, 'the MIX slider has a real label');
}

console.log('edit-modules readable text and notice placement: all assertions passed');
