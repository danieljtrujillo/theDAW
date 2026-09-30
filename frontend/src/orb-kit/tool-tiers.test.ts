import assert from 'node:assert/strict';

import { getToolTier, describeToolCall } from './tool-tiers.ts';

// -- theDAW tools keep their existing tiers ---------------------------------
assert.equal(getToolTier('get_status'), 'T0_silent');
assert.equal(getToolTier('set_prompt'), 'T1_inform');
assert.equal(getToolTier('generate'), 'T2_confirm');

// -- Claude-native read-only tools are silent -------------------------------
for (const tool of [
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'NotebookRead',
]) {
  assert.equal(getToolTier(tool), 'T0_silent', `${tool} should be T0_silent`);
}

// -- Claude-native mutating tools need confirmation -------------------------
for (const tool of [
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'PowerShell',
  'Agent',
  'Task',
]) {
  assert.equal(getToolTier(tool), 'T2_confirm', `${tool} should be T2_confirm`);
}

// -- Unknown tools stay fail-safe -------------------------------------------
assert.equal(getToolTier('SomeToolNobodyDeclared'), 'T2_confirm');
assert.equal(getToolTier(''), 'T2_confirm');

// -- describeToolCall still falls through for the native names --------------
assert.equal(describeToolCall('Bash', { command: 'ls' }), 'Execute tool: Bash');

console.log('tool-tiers regression passed');
