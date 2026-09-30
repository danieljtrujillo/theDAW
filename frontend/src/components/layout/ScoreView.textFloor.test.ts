// The SCORE tab's text is bold sans at 12px or larger.
//
// The preview header (the OTHER TRACK tag, the artifact line, the instrument
// select, the view switch and its hint), its loading and empty lines, the
// sheet's footer bar (the NOW/INK/TRAIL selects and the zoom readout), the
// play-along views' footer (OFFSET ms and CALIBRATE) and the tab view's FOLLOW
// label were 8 to 11px monospace, the smallest text on the screen beside a
// 12px bold notice, and so were the chord, highway, Beat Saber, export and
// calibrator panes. This reads the class strings of the SCORE tab and every
// view under score/, and holds the floor.
//
// Run: `npx tsx src/components/layout/ScoreView.textFloor.test.ts`
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const source = read('./ScoreView.tsx');

const files: Record<string, string> = { 'ScoreView.tsx': source };
// Every view the SCORE tab shows (strip, highway, chords, Beat Saber, the
// export menu, the play-along footer and calibrator, the zoom controls).
const scoreDir = fileURLToPath(new URL('./score/', import.meta.url));
for (const rel of readdirSync(scoreDir, { recursive: true, encoding: 'utf8' })) {
  if (!rel.endsWith('.tsx') || rel.includes('.test.')) continue;
  files[`score/${rel.split(sep).join('/')}`] = readFileSync(join(scoreDir, rel), 'utf8');
}
assert.ok('score/scoreShared.tsx' in files && 'score/chords/ChordPlayAlong.tsx' in files, 'the score views were found');

for (const [name, text] of Object.entries(files)) {
  const small = [...text.matchAll(/\btext-\[(\d+(?:\.\d+)?)px\]/g)].filter((m) => Number(m[1]) < 12);
  assert.deepEqual(small.map((m) => m[0]), [], `${name}: no text size under 12px`);
  assert.equal(/\btext-2xs\b/.test(text), false, `${name}: no text-2xs`);
  assert.equal(/\bfont-mono\b/.test(text), false, `${name}: no monospace labels`);
}

// The header's controls keep their size where the reviewer found them.
assert.match(source, /className="form-select text-xs font-bold px-1 py-0\.5 shrink-0"/, 'the instrument select is 12px bold');
assert.match(source, /<span className="text-xs font-bold text-zinc-400 truncate flex-1">/, 'the artifact line is 12px bold');

console.log('ScoreView.textFloor: ok');
