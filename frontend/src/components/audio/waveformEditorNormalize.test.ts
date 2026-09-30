/**
 * D16 (the other half) — the EDIT timeline's clip body must draw at absolute
 * amplitude, not each clip's own peak-normalized scale, matching REAPER's
 * intent: quiet clips draw smaller than loud ones. (The actual pixel height
 * is gamma-compressed by T24's `drawWaveform` — `pow(peak, 0.58)` with a
 * 0.72 floor — so a -20 dBFS clip draws roughly twice as tall as a LINEAR
 * mapping would give it; ordering is still quiet < loud, which is what
 * `normalize={false}` controls here, not the exact pixel curve.)
 *
 * `WaveformEditor` has no jsdom/AudioContext-friendly seam to mount
 * `ClipWave` (it fetches and decodes real audio inside `SemanticWave`), so —
 * the house pattern for a component-only fix (`audioEditorPanelWiring.test.ts`)
 * — this pins the wiring at SOURCE level: every `<SemanticWave` /
 * `<DJSemanticWaveform` call site in the file must pass `normalize=`
 * EXPLICITLY, and the ONE call that draws the timeline clip body (`ClipWave`)
 * must pass exactly `normalize={false}`.
 *
 * A future SemanticWave/DJSemanticWaveform use added to this file without an
 * explicit `normalize=` fails the "every call site decides" assertion below,
 * rather than silently inheriting whatever `SemanticWave`'s own default is.
 *
 * Two things the call-matching regex has to get right, proven with fixtures
 * below rather than only against the real file:
 *  - A prop value containing `>` (`height={a > b ? 1 : 2}`, an arrow prop
 *    `onReady={() => …}`) must not truncate the match before the tag's own
 *    closing `/>` — matched NON-GREEDILY to the first `/>`, not `[^>]*`.
 *  - A commented-out example call must not count as a real call site —
 *    comments are stripped from the source before scanning.
 *
 * Run: `npx tsx src/components/audio/waveformEditorNormalize.test.ts`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Strips `//` and `/* *\/` comments, skipping over string/template literal
 *  contents (so a URL like `http://…` or a `/* not a comment *\/` inside a
 *  string survives) — good enough for scanning real TSX source, not a full
 *  parser. */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') {
          out += src[i];
          i++;
          if (i < n) { out += src[i]; i++; }
          continue;
        }
        out += src[i];
        i++;
      }
      if (i < n) { out += src[i]; i++; }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Every `<SemanticWave …/>` / `<DJSemanticWaveform …/>` self-closing call in
 *  `src`, comments stripped first. Non-greedy to the first `/>` so a `>`
 *  inside a prop value (a comparison, an arrow function) does not truncate
 *  the match early. */
function waveCalls(src: string): string[] {
  return stripComments(src).match(/<(SemanticWave|DJSemanticWaveform)\b[\s\S]*?\/>/g) ?? [];
}

// ── the matcher itself: proven against fixtures, not only the real file ────
{
  // A `>` inside a prop value must not truncate the match.
  const comparisonProp = '<SemanticWave height={a > b ? 1 : 2} normalize={false} />';
  assert.deepEqual(waveCalls(comparisonProp), [comparisonProp]);

  const arrowProp = '<SemanticWave onReady={() => doThing()} normalize={true} />';
  assert.deepEqual(waveCalls(arrowProp), [arrowProp]);

  // Both shapes together, so the SECOND call is not swallowed into the first
  // by an over-eager (still-too-greedy) match.
  const both = `${comparisonProp}\n${arrowProp}`;
  assert.deepEqual(waveCalls(both), [comparisonProp, arrowProp]);

  // A commented-out example must not count as a call site.
  const commentedOut = `
    // <SemanticWave audioUrl={u} height={h} />
    /* <DJSemanticWaveform audioUrl={u} normalize={true} /> */
    <SemanticWave audioUrl={u} height={h} normalize={false} />
  `;
  const real = waveCalls(commentedOut);
  assert.equal(real.length, 1, 'only the un-commented call counts');
  assert.match(real[0], /normalize=\{false\}/);

  // A call missing `normalize=` is caught by the assertion loop below (this
  // fixture just proves the matcher still FINDS it, so the guard has
  // something to fail on rather than silently seeing zero calls).
  const undecided = '<SemanticWave audioUrl={u} height={h} />';
  assert.deepEqual(waveCalls(undecided), [undecided]);
}

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'WaveformEditor.tsx'),
  'utf8',
);

// ── every SemanticWave / DJSemanticWaveform JSX call decides explicitly ────
{
  const calls = waveCalls(source);
  assert.ok(calls.length > 0, 'sanity: at least one call site exists to check');
  for (const call of calls) {
    assert.match(
      call,
      /\bnormalize=\{/,
      `every SemanticWave/DJSemanticWaveform call must decide \`normalize\` explicitly, not inherit the default — found: ${call}`,
    );
  }
}

// ── the timeline clip body (ClipWave) draws at ABSOLUTE amplitude ──────────
{
  const clipWaveSource = stripComments(source).match(/const ClipWave: React\.FC<[\s\S]*?\/>/);
  assert.ok(clipWaveSource, 'ClipWave (the timeline clip body) with its SemanticWave call must be found');
  const clipWaveCalls = waveCalls(clipWaveSource![0]);
  assert.equal(clipWaveCalls.length, 1, 'ClipWave has exactly one wave call');
  assert.match(
    clipWaveCalls[0],
    /<SemanticWave\b[\s\S]*\bnormalize=\{false\}/,
    'ClipWave must pass normalize={false}: REAPER\'s intent is absolute amplitude, so a quiet clip draws smaller',
  );
}

console.log('waveformEditorNormalize: ok');
