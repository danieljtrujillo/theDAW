import assert from 'node:assert/strict';

import { buildPromptEnhancementRequest, extractEnhancedPrompt } from './promptEnhancer.ts';

const positiveRequest = buildPromptEnhancementRequest({
  target: 'positive',
  positivePrompt: 'dark drums',
  negativePrompt: 'vocals, harsh noise',
});

assert.match(positiveRequest, /Enhance ONLY the positive prompt/);
assert.match(positiveRequest, /dark drums/);
assert.match(positiveRequest, /vocals, harsh noise/);
assert.match(positiveRequest, /docs\/guides\/prompting\.md/);
assert.match(positiveRequest, /<enhanced_prompt>/);

const negativeRequest = buildPromptEnhancementRequest({
  target: 'negative',
  positivePrompt: 'cinematic ambient pad',
  negativePrompt: '',
});

assert.match(negativeRequest, /Enhance ONLY the negative prompt/);
assert.match(negativeRequest, /cinematic ambient pad/);

assert.equal(
  extractEnhancedPrompt('Here you go. <enhanced_prompt>cinematic industrial drums, tight low-end punch</enhanced_prompt>'),
  'cinematic industrial drums, tight low-end punch',
);

assert.equal(
  extractEnhancedPrompt('{"enhanced_prompt":"muddy low end, clipping, harsh cymbals"}'),
  'muddy low end, clipping, harsh cymbals',
);

assert.equal(
  extractEnhancedPrompt('```\nwide analog pad, slow harmonic motion\n```'),
  'wide analog pad, slow harmonic motion',
);

console.log('promptEnhancer regression passed');
