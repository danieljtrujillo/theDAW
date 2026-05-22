import assert from 'node:assert/strict';

import { buildSpectrogramFormData } from './spectrogramRequest.ts';

const form = buildSpectrogramFormData({
  audioBase64: 'abc123',
  mimeType: 'audio/flac',
  sampleRate: 48000,
});

assert.equal(form.get('audio_base64'), 'abc123');
assert.equal(form.get('mime_type'), 'audio/flac');
assert.equal(form.get('sample_rate_form'), '48000');
assert.equal(form.get('sample_rate'), null, 'backend expects sample_rate_form, not sample_rate');

console.log('spectrogram request form regression passed');
