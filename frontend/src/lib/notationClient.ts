export interface NotationArtifact {
  id: string;
  entry_id: string;
  kind:
    | 'midi'
    | 'musicxml'
    | 'pdf'
    | 'svg'
    | 'alphatex'
    | 'guitarpro'
    | 'abc'
    | 'notechart'
    | 'chordtrack'
    | 'beatsaber'
    | 'vocal'
    | 'lyrics'
    | string;
  source_ref?: string | null;
  path: string;
  engine: string;
  engine_version: string;
  metadata_json?: string;
  created_at: number;
  /** MusicXML only: the sheet is one an older build wrote with its transposing
   *  parts at the pitch they sound (backend notation/sheet_pitch.py). */
  legacy_sounding_pitch?: boolean;
  /** MusicXML only: that sheet's MIDI is in the library, so "Rewrite from
   *  MIDI" (rewriteSheetFromMidi) can engrave it again at written pitch. */
  rewrite_from_midi?: boolean;
}

export async function listNotationArtifacts(entryId: string, kind?: string): Promise<NotationArtifact[]> {
  const qs = kind ? `?kind=${encodeURIComponent(kind)}` : '';
  const res = await fetch(`/api/notation/${encodeURIComponent(entryId)}/artifacts${qs}`);
  if (!res.ok) throw new Error(`notation artifacts HTTP ${res.status}`);
  const payload = await res.json() as { artifacts?: NotationArtifact[] };
  return payload.artifacts ?? [];
}

export async function convertMidiToMusicXml(entryId: string, midiId: string): Promise<NotationArtifact | null> {
  const res = await fetch(
    `/api/notation/${encodeURIComponent(entryId)}/from-midi/${encodeURIComponent(midiId)}`,
    { method: 'POST' },
  );
  const payload = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    const detail = (payload as { detail?: unknown }).detail;
    const message = typeof detail === 'object' && detail && 'error' in detail
      ? String((detail as { error?: unknown }).error)
      : `notation conversion HTTP ${res.status}`;
    throw new Error(message);
  }
  return ((payload as { artifact?: NotationArtifact | null }).artifact) ?? null;
}

/**
 * Engrave a sheet an older build wrote at sounding pitch again from its MIDI,
 * at written pitch, over the same file and artifact id. The backend keeps the
 * old file until the new one is written.
 */
export async function rewriteSheetFromMidi(entryId: string, artifactId: string): Promise<NotationArtifact | null> {
  const res = await fetch(
    `/api/notation/${encodeURIComponent(entryId)}/rewrite-from-midi/${encodeURIComponent(artifactId)}`,
    { method: 'POST' },
  );
  const payload = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    const detail = (payload as { detail?: unknown }).detail;
    const message = typeof detail === 'object' && detail && 'error' in detail
      ? String((detail as { error?: unknown }).error)
      : `sheet rewrite HTTP ${res.status}`;
    throw new Error(message);
  }
  return ((payload as { artifact?: NotationArtifact | null }).artifact) ?? null;
}

export interface NotationCapabilities {
  ok: boolean;
  music21: boolean;
  musescore: boolean;
  musescore_path?: string | null;
  /** True when PDF can be engraved headlessly through the frontend's OSMD,
   *  which needs no MuseScore install. */
  osmd_pdf?: boolean;
  /** Engines that can engrave each of pdf / svg, in the order the backend
   *  tries them: 'osmd' (the SCORE tab's own renderer) first, 'musescore' as
   *  the stand-in. An empty list means the format is not offered. */
  engravers?: Record<string, string[]>;
  /** Where to get MuseScore when no engraver is present. */
  musescore_download_url?: string;
  formats: string[];
  tab_tunings?: string[];
  /** Open-string MIDI pitches per tuning id, low string first (the backend's
   *  TUNINGS table verbatim), so chord diagrams use the exact same tunings
   *  the tab arranger does. */
  tab_tuning_pitches?: Record<string, number[]>;
  arrangement_styles?: string[];
  engines?: Record<string, unknown>;
  /** True when chord tracks are buildable. They are never in `formats`:
   *  they reach the entry through POST /{entry}/chords, not /export. */
  chords?: boolean;
  /** True when an ffmpeg binary is reachable, so a Beat Saber export can
   *  encode song.ogg itself. */
  ffmpeg?: boolean;
  /** True when POST /{entry}/perform can play a sheet as a MIDI performance
   *  (partitura is installed). Never in `formats`: it has its own route. */
  perform?: boolean;
  /** What POST /import takes and whether the music21 corpus can be opened. */
  score_import?: {
    extensions: string[];
    max_bytes: number;
    corpus: boolean;
  };
}

/** One piece of the music21 corpus, as GET /api/notation/corpus lists it. */
export interface CorpusPiece {
  /** The corpus path id POST /corpus/open takes (e.g. bach_bwv66_6_mxl). */
  id: string;
  composer: string;
  title: string;
  movement: string;
  parts: number | null;
  /** The file inside the corpus, e.g. bach/bwv66.6.mxl. */
  path: string;
  number?: number | null;
  format?: string;
}

export interface CorpusSearchResult {
  query: string;
  total: number;
  results: CorpusPiece[];
}

/** What POST /import and POST /corpus/open answer: the new composition
 *  entry, its credit, and the sheet the SCORE tab opens. */
export interface ScoreImportResult {
  ok: boolean;
  entry_id: string;
  title: string;
  composer: string;
  sheet: NotationArtifact | null;
  artifacts: NotationArtifact[];
}

/** The backend's error text from a failed notation request. */
async function errorText(res: Response, what: string): Promise<string> {
  const payload = await res.json().catch(() => ({} as Record<string, unknown>));
  const detail = (payload as { detail?: unknown }).detail;
  if (typeof detail === 'string' && detail) return detail;
  if (typeof detail === 'object' && detail && 'error' in detail) return String((detail as { error?: unknown }).error);
  return `${what} HTTP ${res.status}`;
}

/** Import a score file (.musicxml, .xml, .mxl, .krn, .abc) as a composition
 *  entry of its own: POST /api/notation/import. */
export async function importScoreFile(file: File): Promise<ScoreImportResult> {
  const body = new FormData();
  body.append('file', file, file.name);
  const res = await fetch('/api/notation/import', { method: 'POST', body });
  if (!res.ok) throw new Error(await errorText(res, 'score import'));
  return await res.json() as ScoreImportResult;
}

/** Search the music21 corpus: GET /api/notation/corpus?q=. */
export async function searchCorpus(query: string, signal?: AbortSignal): Promise<CorpusSearchResult> {
  const res = await fetch(`/api/notation/corpus?q=${encodeURIComponent(query)}&limit=100`, { signal });
  if (!res.ok) throw new Error(await errorText(res, 'corpus search'));
  return await res.json() as CorpusSearchResult;
}

/** Import one corpus piece as a composition entry: POST /api/notation/corpus/open. */
export async function openCorpusPiece(id: string): Promise<ScoreImportResult> {
  const res = await fetch('/api/notation/corpus/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(await errorText(res, 'corpus open'));
  return await res.json() as ScoreImportResult;
}

/** Options for POST /{entry}/chords (the gantasmo.chordtrack builder). */
export interface ChordTrackRequest {
  /** 'auto' = lead-sheet <harmony> when one exists, else chroma from audio. */
  source?: 'auto' | 'harmony' | 'chroma';
  source_artifact_id?: string;
  include_sevenths?: boolean;
  resolution?: 'beat' | 'bar';
}

/** The `options` dict for exportArtifact(..., 'beatsaber', options). */
export interface BeatSaberExportOptions {
  /** Difficulty names in Beat Saber's vocabulary: Easy, Normal, Hard, Expert, ExpertPlus. */
  difficulties?: string[];
  /** Map format version; 2 has the widest tool support. */
  version?: 2 | 3;
  /** Which BPM Info.dat states: the analysis BPM (default) or the chart's tempo map. */
  bpm_source?: 'analysis' | 'chart';
  /** Part indices to map; every non-percussion part when omitted. */
  parts?: number[];
  include_audio?: boolean;
}

export interface MakeTabsRequest {
  source_artifact_id?: string;
  midi_id?: string;
  instrument?: string;
  tuning_name?: string;
  tuning?: number[];
  capo?: number;
  difficulty?: string;
}

export interface MakeArrangementRequest {
  style: string;
  source_artifact_id?: string;
  source_artifact_ids?: string[];
  midi_id?: string;
}

export async function getNotationCapabilities(): Promise<NotationCapabilities> {
  const res = await fetch('/api/notation');
  if (!res.ok) throw new Error(`notation capabilities HTTP ${res.status}`);
  return await res.json() as NotationCapabilities;
}

export async function exportArtifact(
  entryId: string,
  sourceArtifactId: string,
  format: string,
  options?: Record<string, unknown>,
): Promise<NotationArtifact | null> {
  const res = await fetch(`/api/notation/${encodeURIComponent(entryId)}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_artifact_id: sourceArtifactId, format, options: options ?? {} }),
  });
  const payload = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    const detail = (payload as { detail?: unknown }).detail;
    const message = typeof detail === 'object' && detail && 'error' in detail
      ? String((detail as { error?: unknown }).error)
      : `notation export HTTP ${res.status}`;
    throw new Error(message);
  }
  return ((payload as { artifact?: NotationArtifact | null }).artifact) ?? null;
}

/**
 * POST /{entry}/perform: play a MusicXML sheet as an expressive MIDI
 * (ritardandos into cadences, fermatas, printed dynamics and articulation,
 * a tempo map on the sheet's beat grid). Returns the registered `midi`
 * artifact; throws with the backend's error when the sheet cannot be played.
 */
export async function performScore(
  entryId: string,
  sourceArtifactId: string,
  bpm?: number,
): Promise<NotationArtifact | null> {
  const res = await fetch(`/api/notation/${encodeURIComponent(entryId)}/perform`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bpm ? { source_artifact_id: sourceArtifactId, bpm } : { source_artifact_id: sourceArtifactId }),
  });
  const payload = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    const detail = (payload as { detail?: unknown }).detail;
    const message = typeof detail === 'object' && detail && 'error' in detail
      ? String((detail as { error?: unknown }).error)
      : typeof detail === 'string'
        ? detail
        : `notation perform HTTP ${res.status}`;
    throw new Error(message);
  }
  return ((payload as { artifact?: NotationArtifact | null }).artifact) ?? null;
}

export async function makeTabs(
  entryId: string,
  req: MakeTabsRequest,
): Promise<NotationArtifact | null> {
  const res = await fetch(`/api/notation/${encodeURIComponent(entryId)}/tabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  const payload = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    const detail = (payload as { detail?: unknown }).detail;
    const message = typeof detail === 'object' && detail && 'error' in detail
      ? String((detail as { error?: unknown }).error)
      : `tab generation HTTP ${res.status}`;
    throw new Error(message);
  }
  return ((payload as { artifact?: NotationArtifact | null }).artifact) ?? null;
}

export async function makeArrangement(
  entryId: string,
  req: MakeArrangementRequest,
): Promise<NotationArtifact | null> {
  const res = await fetch(`/api/notation/${encodeURIComponent(entryId)}/arrange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  const payload = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    const detail = (payload as { detail?: unknown }).detail;
    const message = typeof detail === 'object' && detail && 'error' in detail
      ? String((detail as { error?: unknown }).error)
      : `arrangement HTTP ${res.status}`;
    throw new Error(message);
  }
  return ((payload as { artifact?: NotationArtifact | null }).artifact) ?? null;
}

/** Build (or rebuild) the entry's chord track: POST /{entry}/chords. Returns
 *  the registered 'chordtrack' artifact; throws with the backend's error text
 *  (404 when nothing can be derived, 501 with the builder's error). */
export async function makeChordTrack(
  entryId: string,
  req: ChordTrackRequest,
): Promise<NotationArtifact | null> {
  const res = await fetch(`/api/notation/${encodeURIComponent(entryId)}/chords`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  const payload = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) {
    const detail = (payload as { detail?: unknown }).detail;
    const message = typeof detail === 'object' && detail && 'error' in detail
      ? String((detail as { error?: unknown }).error)
      : typeof detail === 'string' && detail
        ? detail
        : `chord track HTTP ${res.status}`;
    throw new Error(message);
  }
  return ((payload as { artifact?: NotationArtifact | null }).artifact) ?? null;
}

export function notationArtifactUrl(artifactId: string): string {
  return `/api/notation/file/${encodeURIComponent(artifactId)}`;
}

// ---- artifact text cache ---------------------------------------------------
// A MusicXML or alphaTex file is fetched once per artifact id and kept, so
// switching PAGE <-> STRIP, or coming back to a score, does not hit the
// network (or re-read a multi-MB file) again. Artifact ids are unique per
// conversion, so a stale hit is only possible for the few deterministic ids;
// loadArtifacts() clears the cache whenever the list is refreshed.
const ARTIFACT_TEXT_CACHE_MAX = 12;
const artifactTextCache = new Map<string, Promise<string>>();

/** The artifact's text body, cached by id (bounded, oldest evicted). */
export function fetchArtifactText(artifactId: string): Promise<string> {
  const hit = artifactTextCache.get(artifactId);
  if (hit) return hit;
  const pending = fetch(notationArtifactUrl(artifactId)).then(async (res) => {
    if (!res.ok) {
      artifactTextCache.delete(artifactId);
      throw new Error(`artifact HTTP ${res.status}`);
    }
    return res.text();
  });
  pending.catch(() => artifactTextCache.delete(artifactId));
  artifactTextCache.set(artifactId, pending);
  while (artifactTextCache.size > ARTIFACT_TEXT_CACHE_MAX) {
    const oldest = artifactTextCache.keys().next().value;
    if (oldest === undefined) break;
    artifactTextCache.delete(oldest);
  }
  return pending;
}

/** Forget cached text (one artifact, or everything). */
export function invalidateArtifactText(artifactId?: string): void {
  if (artifactId) artifactTextCache.delete(artifactId);
  else artifactTextCache.clear();
}

/** Download a score as a zip of the symbolic source + a PDF engraved on
 *  download (the headless OSMD renderer, or MuseScore when that is missing;
 *  with neither the zip carries the source alone). A musicxml sheet packs as
 *  MusicXML + PDF, a midi artifact as MIDI + PDF. `parts` (indices in
 *  <part-list> order) scopes both members to those parts (`?parts=0,2`). */
export function notationPackUrl(artifactId: string, parts?: number[]): string {
  const base = `/api/notation/pack/${encodeURIComponent(artifactId)}`;
  return parts && parts.length > 0 ? `${base}?parts=${parts.map((p) => String(p)).join(',')}` : base;
}