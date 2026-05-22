export interface SpectrogramFormDataInput {
  audioBase64: string;
  mimeType?: string;
  sampleRate?: number;
}

export function buildSpectrogramFormData({
  audioBase64,
  mimeType = 'audio/wav',
  sampleRate = 44100,
}: SpectrogramFormDataInput): FormData {
  const form = new FormData();
  form.append('audio_base64', audioBase64);
  form.append('mime_type', mimeType);
  form.append('sample_rate_form', String(sampleRate));
  return form;
}
