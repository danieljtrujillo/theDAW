/**
 * FE-025 end-to-end bundle-split proof — deliberately NOT named
 * `*.test.ts(x)` so `scripts/run-tests.mjs` (which discovers every
 * `*.test.tsx?` file under src/) does NOT pick this up as part of the
 * regular `npm test` run: a real production `vite build` takes ~35s, which
 * every other suite in this repo would otherwise pay on every `npm test`.
 * Run explicitly via `npm run test:bundle`.
 *
 * The fast, cheap source-level checks (no static import, has the dynamic
 * import, has a `.catch`) stay in App.test.ts and run as part of the normal
 * suite — this file is ONLY the slow real-build property that a source scan
 * cannot see: controllerProfiles.ts (state/controllerProfiles.ts — a 400+
 * line static table of every known DJ/MIDI controller's control layout) is
 * reachable eagerly not just via App.tsx directly, but also via
 * App -> Shell -> BottomMultiTabPanel (a static
 * `import { SlidePanel } from './SlidePanel'`, and a static
 * `import { useSlideStore } from '../../state/slideStore'` whose module
 * statically imported `DEFAULT_PROFILE_ID` from controllerProfiles.ts) —
 * neither of those edges shows up in App.tsx's own source, so only a real
 * bundler run can prove the table stays out of the first-paint bundle.
 *
 * Run: `npm run test:bundle` (from frontend/), or `npx tsx src/App.bundle.check.ts`
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = join(appDir, '..');

// A fresh, OS-appropriate temp dir per run (Windows or Linux/CI alike) —
// never a hardcoded path, and never inside the repo (a build artifact
// committed by accident would be a mess to untangle).
const outDir = mkdtempSync(join(tmpdir(), 'b12-t20-'));

try {
  // spawnSync (not execFileSync) so BOTH stdout and stderr are captured —
  // Rollup/Vite prints its "(!) ... dynamic import will not move module ..."
  // warnings to stderr, and execFileSync's return value is stdout only.
  const build = spawnSync(
    process.execPath,
    [join(frontendDir, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', outDir, '--emptyOutDir'],
    { cwd: frontendDir, encoding: 'utf8' },
  );
  const buildOutput = `${build.stdout ?? ''}\n${build.stderr ?? ''}`;
  assert.equal(build.status, 0, `vite build failed:\n${buildOutput}`);

  // The codebase has several PRE-EXISTING "dynamic import will not move
  // module" warnings for other, unrelated modules (playerStore, saveFile,
  // generateStore, ...) — not this ticket's concern. Rollup's phrasing is
  // "(!) <path/to/MOVED-MODULE> is dynamically imported by <path/to/importer>
  // but also statically imported by <comma-separated list>, dynamic import
  // will not move module into another chunk." — the module that FAILED to
  // move is always the one named immediately after "(!)", at the START of
  // the line, not anywhere in the "also statically imported by" list. A
  // substring match anywhere in the line would false-positive on some OTHER
  // module's warning whose static-importer list happens to mention
  // controllerProfiles.ts or SlidePanel.tsx by path; anchoring to the start
  // of the line is what actually proves THIS module failed to split.
  const relevantWarningLines = buildOutput
    .split('\n')
    .filter((line) => /^\(!\)\s+\S*[/\\](controllerProfiles\.ts|SlidePanel\.tsx)\s+is dynamically imported by/i.test(line));
  assert.deepEqual(
    relevantWarningLines,
    [],
    `Vite must not warn that controllerProfiles.ts/SlidePanel.tsx's dynamic import could not be split out (that warning means it stayed in the eager graph):\n${relevantWarningLines.join('\n')}`,
  );

  const assetsDir = join(outDir, 'assets');
  assert.ok(existsSync(assetsDir), `build produced no ${assetsDir}`);
  const jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
  assert.ok(jsFiles.length > 0, 'build produced no JS assets');

  // The entry chunk is the one that imports index.html's module script —
  // find it via index.html's own script tag, exactly what the browser would
  // load on first paint (as opposed to any lazy chunk, which is fine to
  // contain it).
  const indexHtml = readFileSync(join(outDir, 'index.html'), 'utf8');
  const entryMatch = indexHtml.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/);
  assert.ok(entryMatch, 'index.html must have a module entry script tag');
  const entryRelPath = entryMatch![1].replace(/^\//, '');
  const entryChunk = readFileSync(join(outDir, entryRelPath), 'utf8');

  // A string that exists ONLY inside CONTROLLER_PROFILES' table data (a
  // specific model id + its match pattern) — not referenced anywhere else in
  // the app, so its presence in the entry chunk can only mean the table
  // itself landed there.
  //
  // T20 re-audit item 5: this sentinel is TABLE DATA
  // (state/controllerProfiles.ts), not a stable API. Renaming or removing
  // that one profile entry silently turns `assert.doesNotMatch` below into a
  // test that can never fail regardless of whether the table actually stays
  // out of the eager bundle. Assert the sentinel is still present in its
  // source of truth FIRST, so a rename there breaks this build loudly
  // instead of leaving the real assertion permanently vacuous.
  const controllerProfilesSource = readFileSync(
    join(frontendDir, 'src', 'state', 'controllerProfiles.ts'),
    'utf8',
  );
  assert.match(
    controllerProfilesSource,
    /pioneer-ddj-flx10/,
    'sentinel "pioneer-ddj-flx10" must still exist in state/controllerProfiles.ts — if it was renamed or removed, update this check\'s sentinel to match, or the assertion below silently stops proving anything',
  );

  assert.doesNotMatch(
    entryChunk,
    /pioneer-ddj-flx10/,
    'the entry chunk (first-paint bundle) must not contain the controller profile table — controllerProfiles is reachable eagerly through some import edge',
  );

  console.log('App.bundle.check: all assertions passed');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
