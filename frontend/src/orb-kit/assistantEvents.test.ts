import assert from 'node:assert/strict';

import { actionFromAssistantEvent, statusFromAssistantEvent } from './assistantEvents.ts';

const nativeAction = actionFromAssistantEvent({
  type: 'action',
  action_type: 'navigate',
  payload: { tab: 'advanced' },
});
assert.deepEqual(nativeAction, {
  type: 'navigate',
  payload: { tab: 'advanced' },
});

const appFunctionCall = actionFromAssistantEvent({
  type: 'function_call',
  name: 'set_prompt',
  input: { prompt: 'dark industrial drums' },
});
assert.deepEqual(appFunctionCall, {
  type: 'set_prompt',
  payload: { prompt: 'dark industrial drums' },
});

const openAiStyleFunctionCall = actionFromAssistantEvent({
  type: 'tool_call',
  function: {
    name: 'set_duration',
    arguments: '{"duration":45}',
  },
});
assert.deepEqual(openAiStyleFunctionCall, {
  type: 'set_duration',
  payload: { duration: 45 },
});

const nonAppTool = actionFromAssistantEvent({
  type: 'function_call',
  name: 'Read',
  input: { file_path: 'README.md' },
});
assert.equal(nonAppTool, null);

const malformedAction = actionFromAssistantEvent({
  type: 'action',
  payload: { tab: 'advanced' },
});
assert.equal(malformedAction, null);

const promptAction = actionFromAssistantEvent({
  type: 'action',
  action_type: 'improve_prompt',
  payload: { prompt: 'cinematic industrial drums, tight transient punch' },
});
assert.deepEqual(promptAction, {
  type: 'improve_prompt',
  payload: { prompt: 'cinematic industrial drums, tight transient punch' },
});

const docsAction = actionFromAssistantEvent({
  type: 'action',
  action_type: 'open_docs',
  payload: {},
});
assert.deepEqual(docsAction, {
  type: 'open_docs',
  payload: {},
});

const readStatus = statusFromAssistantEvent({
  type: 'function_call',
  name: 'Read',
  input: { file_path: 'frontend/src/App.tsx' },
});
assert.equal(readStatus, 'Claude Code: using Read');

const appActionStatus = statusFromAssistantEvent({
  type: 'action',
  action_type: 'navigate',
  payload: { tab: 'advanced' },
});
assert.equal(appActionStatus, null);

const resultStatus = statusFromAssistantEvent({
  type: 'function_result',
  name: 'Bash',
});
assert.equal(resultStatus, 'Claude Code: Bash complete');

console.log('assistantEvents action normalization regression passed');
