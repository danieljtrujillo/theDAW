/**
 * The EDIT inpaint request (lib/editInpaintForm): the field names and values
 * /api/generate-jobs reads for the composite and its seam tuning, and the
 * crop's float encoding.
 */
import assert from 'node:assert/strict';
import {
  INPAINT_FEATHER_DEFAULT_SEC,
  INPAINT_FEATHER_MAX_SEC,
  buildEditInpaintForm,
  encodeEditInpaintCrop,
  type EditInpaintRequest,
} from './editInpaintForm';

const request: EditInpaintRequest = {
  model: 'small',
  prompt: 'a brass stab',
  steps: 8,
  seed: -1,
  durationSec: 8,
  maskStartSec: 2,
  maskEndSec: 3.5,
  featherSec: INPAINT_FEATHER_DEFAULT_SEC,
  matchLoudness: true,
  audio: new Blob(['wav'], { type: 'audio/wav' }),
};

// The composite is asked for, with a float round trip.
{
  const fd = buildEditInpaintForm(request);
  assert.equal(fd.get('composite_original'), 'true');
  assert.equal(fd.get('wav_bit_depth'), '32f');
  assert.equal(fd.get('mask_feather_sec'), '0.100');
  assert.equal(fd.get('match_loudness'), 'true');
  assert.equal(fd.get('model_name'), 'small');
  assert.equal(fd.get('duration'), '8');
  assert.equal(fd.get('mask_start'), '2');
  assert.equal(fd.get('mask_end'), '3.5');
  assert.equal((fd.get('inpaint_audio') as File).name, 'inpaint.wav');
  // MAKE's region list is not part of this request; the seconds path is.
  assert.equal(fd.has('inpaint_regions'), false);
}

// The seam tuning follows the panel: loudness off, a short feather.
{
  const fd = buildEditInpaintForm({ ...request, featherSec: 0.035, matchLoudness: false });
  assert.equal(fd.get('mask_feather_sec'), '0.035');
  assert.equal(fd.get('match_loudness'), 'false');
}

// The feather stays inside the range the backend accepts.
{
  assert.equal(buildEditInpaintForm({ ...request, featherSec: -1 }).get('mask_feather_sec'), '0.000');
  assert.equal(
    buildEditInpaintForm({ ...request, featherSec: 0.5000000001 }).get('mask_feather_sec'),
    INPAINT_FEATHER_MAX_SEC.toFixed(3),
  );
}

// A selection dragged past either end of the clip is cut to the clip.
{
  const fd = buildEditInpaintForm({ ...request, maskStartSec: -0.2, maskEndSec: 9 });
  assert.equal(fd.get('mask_start'), '0');
  assert.equal(fd.get('mask_end'), '8');
}

// The crop the request carries is float, so the samples the backend puts back
// outside the selection are the clip's own, bit for bit, overs included.
const cropRoundTrip = async () => {
  const left = new Float32Array([0.1234567, -0.7654321, 1.5, 3e-6]);
  const right = new Float32Array([-0.25, 0.3333333, -1.25, 0]);
  // encodeWav reads only these four members of an AudioBuffer.
  const clipWindow = {
    numberOfChannels: 2,
    sampleRate: 44100,
    length: left.length,
    getChannelData: (c: number) => (c === 0 ? left : right),
  } as unknown as AudioBuffer;
  const wav = new DataView(await encodeEditInpaintCrop(clipWindow).arrayBuffer());
  assert.equal(wav.getUint16(20, true), 3, 'WAVE_FORMAT_IEEE_FLOAT');
  assert.equal(wav.getUint16(34, true), 32, '32 bits per sample');
  const dataAt = 58; // float WAV header (lib/wavEncode)
  for (let i = 0; i < left.length; i += 1) {
    assert.equal(wav.getFloat32(dataAt + i * 8, true), left[i]);
    assert.equal(wav.getFloat32(dataAt + i * 8 + 4, true), right[i]);
  }
};

void cropRoundTrip().then(() => console.log('editInpaintForm: all tests passed'));
