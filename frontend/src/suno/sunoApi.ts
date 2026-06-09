/**
 * sunoApi — thin client over the backend Suno proxy (/api/suno/*).
 *
 * The browser NEVER sees the Suno key — every call hits our own backend module
 * which injects the Authorization header. Vite proxies /api to the backend.
 *
 * Endpoints (per backend contract):
 *   GET  /status            → { configured, key_prefix }
 *   POST /key   { key }     → { configured, key_prefix }
 *   GET  /voices            → { voices }
 *   POST /simple|custom|cover|mashup → SunoJob
 *   GET  /poll/{id}         → SunoJob
 *   GET  /jobs              → { jobs }
 *   GET  /usage             → usage record
 *   GET  /audio/{id}        → MP3 blob
 */

export type SunoStatus = 'submitted' | 'queued' | 'streaming' | 'complete' | 'error';

export interface SunoJob {
  id: string;
  status: SunoStatus;
  audio_url?: string;
  title?: string;
  created_at?: string;
  error?: string | null;
  artifact_dir?: string | null;
  metadata?: {
    lyrics?: string | null;
    style?: string | null;
    description?: string | null;
    voice_id?: string | null;
    cover_audio_id?: string | null;
    mashup_clip_ids?: string[] | null;
  } | null;
}

export interface SunoVoice {
  id: string;
  name: string;
  description: string;
}

/** Parse a JSON response, throwing a useful Error on non-2xx. */
const jsonOrThrow = async (resp: Response): Promise<any> => {
  let payload: any = null;
  try {
    payload = await resp.json();
  } catch {
    payload = null;
  }
  if (!resp.ok) {
    const detail =
      (payload && (payload.detail || payload.error)) || `HTTP ${resp.status} ${resp.statusText}`;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return payload;
};

const postJson = (path: string, body: unknown) =>
  fetch(`/api/suno${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(jsonOrThrow);

const getJson = (path: string) => fetch(`/api/suno${path}`).then(jsonOrThrow);

export const sunoApi = {
  getStatus: (): Promise<{ configured: boolean; key_prefix: string | null }> => getJson('/status'),
  setKey: (key: string): Promise<{ configured: boolean; key_prefix: string }> =>
    postJson('/key', { key }),
  getVoices: (): Promise<{ voices: SunoVoice[] }> => getJson('/voices'),

  simple: (body: { description: string; title?: string; voice_id?: string }): Promise<SunoJob> =>
    postJson('/simple', body),
  custom: (body: {
    style: string;
    lyrics?: string;
    title?: string;
    voice_id?: string;
    instrumental?: boolean;
  }): Promise<SunoJob> => postJson('/custom', body),
  cover: (body: {
    source_id: string;
    lyrics?: string;
    style?: string;
    voice_id?: string;
  }): Promise<SunoJob> => postJson('/cover', body),
  mashup: (body: {
    source_id: string;
    additional_audio_id: string;
    lyrics?: string;
    style?: string;
    title?: string;
  }): Promise<SunoJob> => postJson('/mashup', body),

  poll: (id: string): Promise<SunoJob> => getJson(`/poll/${id}`),
  listJobs: (): Promise<{ jobs: SunoJob[] }> => getJson('/jobs'),
  usage: (): Promise<Record<string, any>> => getJson('/usage'),

  /** Fetch the finished MP3 as a Blob (served by our backend → no CORS). */
  fetchAudioBlob: async (id: string): Promise<Blob> => {
    const resp = await fetch(`/api/suno/audio/${id}`);
    if (!resp.ok) throw new Error(`Audio fetch failed: HTTP ${resp.status}`);
    return resp.blob();
  },
};
