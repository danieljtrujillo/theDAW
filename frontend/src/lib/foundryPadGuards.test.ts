/**
 * The Foundry's custom-code pads must not be process-isolated.
 *
 * Chromium's IsolateSandboxedIframes moves a frame sandboxed without
 * allow-same-origin into its own renderer process. The Foundry's pads grow
 * about 250 MB a second in that process, are killed near 2.4 GB, and are
 * painted grey. Two things prevent it, and this fails if either is removed:
 *
 *   1. the pad iframe carries allow-same-origin, which applies in every
 *      runtime including a browser tab on the dev server
 *   2. the desktop app disables the feature with a launch switch
 *
 * This has regressed twice. A test that reads the two files is the only thing
 * that notices, because the symptom appears in one window and not another.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const frame = readFileSync(
  join(repoRoot, 'VST-Foundry-UI', 'VST-UI-FOUNDRY', 'src', 'components', 'CustomCodeFrame.tsx'),
  'utf8',
);

const sandboxAttr = frame.match(/sandbox="([^"]*)"/);
assert.ok(sandboxAttr, 'the pad iframe has no sandbox attribute at all');
const tokens = sandboxAttr[1].split(/\s+/).filter(Boolean);
assert.ok(
  tokens.includes('allow-scripts'),
  'the pad iframe must keep allow-scripts: the pads are scripts',
);
assert.ok(
  tokens.includes('allow-same-origin'),
  'the pad iframe must keep allow-same-origin, or Chromium isolates it into a ' +
    'renderer process that leaks and is killed, and the pads render grey',
);

const electronMain = readFileSync(
  join(repoRoot, 'electron-ui', 'main', 'index.ts'),
  'utf8',
);
assert.match(
  electronMain,
  /disabledFeatures\s*=\s*\[[^\]]*'IsolateSandboxedIframes'/,
  'the desktop app must keep IsolateSandboxedIframes in its disabled features',
);
assert.match(
  electronMain,
  /appendSwitch\('disable-features',\s*disabledFeatures\.join\(','\)\)/,
  'the disabled features must reach Chromium through disable-features',
);

// One appendSwitch per switch name: a second call for disable-features
// replaces the first, which would drop the isolation opt-out silently.
const disableFeatureCalls = electronMain.match(/appendSwitch\('disable-features'/g) ?? [];
assert.equal(
  disableFeatureCalls.length,
  1,
  'disable-features is set more than once; the last call wins and the others are lost',
);

console.log('foundry pad guards: ok');
