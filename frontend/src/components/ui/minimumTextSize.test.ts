/**
 * No text under 12px and no mono labels in the DJ, EDIT, MIX, assistant and
 * Settings surfaces.
 *
 * These files carried 6-11px text (`text-[7px]` pad captions, `text-[8px]`
 * mono counts, `text-[9px]` hints) and IBM Plex Mono labels that could not be
 * read at 1920x1080. Labels are now 12px (text-xs) bold or semibold sans;
 * section headers in EDIT use Orbitron (font-display) like the headers round
 * one restyled there. Text inputs keep their mono face at 12px: that is typed
 * content (URLs, keys, prompts), and the guard tells them apart by the focus /
 * placeholder utilities only a field carries. Process log output shown as-is
 * (the Underfit sidecar's log tail, `whitespace-pre-wrap`) keeps mono at 12px too.
 *
 * The views need the full store tree to render, so per the house pattern for a
 * component-only fix (see MixView.vstBrowser.test.ts) this checks the SOURCE.
 *
 * Run: npx tsx src/components/ui/minimumTextSize.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = [
  'views/DJView.tsx',
  'views/MixView.tsx',
  'components/audio/WaveformEditor.tsx',
  'components/audio/SlidePad.tsx',
  'components/layout/AudioEditorPanel.tsx',
  'components/layout/settings/shared.tsx',
  'orb-kit/AssistantPanel.tsx',
  'views/UnderfitView.tsx',
];

/** The quoted class list around `pos` on one line. */
function literalAt(line: string, pos: number): string {
  let l = pos;
  while (l > 0 && !`'"\``.includes(line[l - 1])) l--;
  const q = line[l - 1];
  let r = pos;
  while (r < line.length && line[r] !== q) r++;
  return line.slice(l, r);
}
const isFieldClassList = (lit: string) =>
  /placeholder:|focus:outline|focus:border|resize-none|whitespace-pre-wrap/.test(lit);

const small: string[] = [];
const mono: string[] = [];
for (const rel of FILES) {
  readFileSync(join(src, rel), 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      for (const m of line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
        if (Number(m[1]) < 12) small.push(`${rel}:${i + 1} ${m[0]}`);
      }
      for (const m of line.matchAll(/\bfont-mono\b/g)) {
        if (!isFieldClassList(literalAt(line, m.index ?? 0))) mono.push(`${rel}:${i + 1}`);
      }
    });
}
assert.deepEqual(small, [], `text under 12px:\n${small.join('\n')}`);
assert.deepEqual(mono, [], `mono labels (only text fields may be mono):\n${mono.join('\n')}`);

// SlidePad's own legend size is what every DJ pad renders at.
const slidePad = readFileSync(join(src, 'components/audio/SlidePad.tsx'), 'utf8');
assert.match(slidePad, /textSize = 'text-xs'/, 'SlidePad legends default to 12px');

console.log('minimumTextSize: ok');
