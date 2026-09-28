/**
 * StorageProvider implementation that talks to the backend's
 * `/api/library/*` endpoints. Audio lives on the server's filesystem
 * (default: `<project>/data/generations/`). This is the default for the
 * local-dev / self-hosted use case.
 *
 * A future cloud provider (S3 / R2 / Drive) plugs into the same
 * `StorageProvider` interface.
 */

import type {
  ImportRequest,
  LibraryEntry,
  LibraryEntryPatch,
} from '../state/libraryEntry';
import type { StorageProvider } from './storageProvider';
import { fetchBlobWithRetry } from './fetchRetry';
import type { LibraryFacetField, LibraryFacetValue, LibraryFacets } from './libraryFacets';
import { stripSourceId } from './displayName';
import { logWarn } from '../state/logStore';
import { asSearchCoverage, openingErrorFrom, type LibrarySearchCoverage } from './libraryIndexStatus';

export type {
  LibraryFacetField,
  LibraryFacetValue,
  LibraryFacets,
} from './libraryFacets';

const DEFAULT_BASE = '/api/library';

interface ServerRecord {
  id: string;
  title: string;
  prompt: string;
  negative_prompt: string;
  model: string;
  duration: number;
  steps: number;
  cfg: number;
  seed: number;
  audio_url: string;
  audio_filename: string;
  file_size_bytes: number;
  mime_type: string;
  timestamp: string;
  favorite: boolean;
  rating: 'like' | 'dislike' | null;
  tags: string[];
  notes: string;
  lyrics?: string;
  // A paged list row drops `lyrics` when it is long and sends the first 280
  // characters here instead (`has_lyrics` says the full text exists). The full
  // text always stays on GET /entries/{id}, which is what `fetchLibraryEntry`
  // asks for, so an inspector that needs it gets it.
  lyrics_preview?: string;
  has_lyrics?: boolean;
  source: string;
  // The provider the backend detected from the file's own embedded metadata.
  // All four are null (not absent) on an entry with no detectable origin, and
  // absent entirely on a backend that predates provider detection.
  provider?: string | null;
  provider_label?: string | null;
  provider_is_ai?: boolean | null;
  provider_id?: string | null;
  chimera_sources?: string[];
  play_count?: number;
  last_played_at?: number | null;
  cover_url?: string | null;
  // The record's media kind. /entries lists audio unless asked for ?kind=media
  // or ?kind=all, and older backends omit the field.
  kind?: 'audio' | 'video' | 'image';
  // Enrichment attached by the backend's `_attach_analysis` (only present once
  // the entry has been analyzed). Flat scalar analysis dict + parsed embedded
  // file tags — see LibraryEntry.analysis / .embeddedTags.
  analysis?: Record<string, unknown>;
  embedded_tags?: Record<string, unknown>;
}

/**
 * Entry ids whose FULL lyrics text (not the 280-character list preview) has
 * actually been seen this session — a single-entry GET always carries it in
 * full, and so does a paged/list row when the lyrics are short enough that
 * the backend didn't need to truncate (see `toEntry`, which populates this).
 *
 * `patchToServerKeys` consults it before forwarding a `lyrics` patch: a
 * preview-only entry's `.lyrics` field holds the 280-character stand-in
 * (below), so a save path that includes it in a patch — a naive spread of a
 * preview-only entry, today or in the future — would otherwise silently
 * truncate the server's full lyrics down to that preview. MAJOR, possible
 * data loss; see FE-T22 follow-up 2. No current caller sends `lyrics`
 * through a spread (traced every `update()`/`updateEntry()` call site at the
 * time of this fix), but the ambiguity baked into `toEntry`'s single
 * `lyrics` field makes that one accidental spread away at any time, so the
 * guard lives at the one choke point every save passes through rather than
 * trusting every future caller to remember.
 */
const knownFullLyricsIds = new Set<string>();

const toEntry = (r: ServerRecord): LibraryEntry => {
  if (r.lyrics !== undefined) knownFullLyricsIds.add(r.id);
  return {
    id: r.id,
    // Strip the importer's source id ONCE, here at the read boundary, so
    // every panel that renders a title gets a clean one. `audioFilename`
    // below stays raw: it resolves files and backs the Filename row.
    title: stripSourceId(r.title),
    prompt: r.prompt,
    negativePrompt: r.negative_prompt,
    model: r.model,
    duration: r.duration,
    steps: r.steps,
    cfg: r.cfg,
    seed: r.seed,
    audioUrl: r.audio_url,
    audioFilename: r.audio_filename,
    fileSizeBytes: r.file_size_bytes,
    mimeType: r.mime_type,
    timestamp: r.timestamp,
    favorite: r.favorite,
    rating: r.rating,
    tags: r.tags ?? [],
    notes: r.notes ?? '',
    // A paged row carries at most the preview; the full text arrives with the
    // single-entry fetch and replaces it in the cache. DISPLAY ONLY — see
    // `knownFullLyricsIds` for why a save must not trust this blindly.
    lyrics: r.lyrics ?? r.lyrics_preview ?? '',
    source: (['generate', 'studio', 'import'].includes(r.source)
      ? r.source
      : 'generate') as LibraryEntry['source'],
    // Detected provider, snake_case → camelCase. Normalized to null (never
    // undefined) so "this backend answered, and the answer is none" and "this
    // backend has no provider detection" both read as no badge, no filter.
    provider: r.provider ?? null,
    providerLabel: r.provider_label ?? null,
    providerIsAi: r.provider_is_ai ?? null,
    providerId: r.provider_id ?? null,
    chimeraSources: r.chimera_sources ?? [],
    playCount: r.play_count ?? 0,
    lastPlayedAt: r.last_played_at ?? null,
    // Cover art the backend found embedded in the file. Null (not undefined)
    // when there is none, so the UI knows the answer without a probe request.
    coverUrl: r.cover_url ?? null,
    // Carry the kind through, so a list that keeps audio sees what the backend
    // said. A record without one is audio, as LibraryEntry.kind documents.
    kind: r.kind ?? 'audio',
    // Pass the backend analysis enrichment straight through (snake_case →
    // camelCase only). Left undefined when the entry hasn't been analyzed, which
    // the inspector + search treat as "no extra data" rather than empty objects.
    analysis: r.analysis,
    embeddedTags: r.embedded_tags,
  };
};

const patchToServerKeys = (id: string, patch: LibraryEntryPatch): Record<string, unknown> => {
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.favorite !== undefined) body.favorite = patch.favorite;
  if (patch.rating !== undefined) body.rating = patch.rating;
  if (patch.tags !== undefined) body.tags = patch.tags;
  if (patch.notes !== undefined) body.notes = patch.notes;
  if (patch.lyrics !== undefined) {
    if (knownFullLyricsIds.has(id)) {
      body.lyrics = patch.lyrics;
    } else {
      // Never send lyrics for an id whose full text this session has never
      // actually loaded — it could only be the 280-character preview. Drop
      // just this key, silently: every OTHER field in the same patch still
      // applies, the same as a caller who simply never mentioned lyrics.
      logWarn(
        'library',
        `update(${id.slice(0, 8)}): dropped a lyrics patch — full lyrics for this entry were never loaded, so it could only be the list preview`,
      );
    }
  }
  if (patch.chimeraSources !== undefined) body.chimera_sources = patch.chimeraSources;
  return body;
};

/**
 * Default byte budget for the in-memory audio blob cache. Library files
 * average ~26 MB (mostly uncompressed WAV, not compressed audio), so 256 MiB
 * holds roughly 10 tracks resident — a generous working set for a session's
 * scrubbing/auditioning (MATCH previews, a big playlist scrub, an hour of
 * Scout auditions) without growing without bound.
 */
export const AUDIO_BLOB_CACHE_BUDGET_BYTES = 256 * 1024 * 1024;

/**
 * Byte-bounded LRU cache for audio Blobs fetched via `fetchAudioBlob`.
 *
 * The `Map<string, Promise<Blob>>` this replaces never freed an entry, so a
 * long session held every audio Blob it ever fetched in RAM for the life of
 * the tab (FE-019). This caps total resident bytes and evicts the
 * least-recently-used entry to make room — the same convention
 * `decodeCache.ts` uses for decoded PCM, except a Blob's own `.size` is the
 * byte cost here, no derivation needed.
 *
 * A failed fetch's entry is removed on rejection, so the same id can be
 * retried later (mirrors the old `.catch` cleanup). A blob is only charged to
 * the budget once it has actually arrived, so a slow fetch cannot be evicted
 * out from under itself — its provisional entry costs 0 bytes until it
 * resolves. The entry that JUST resolved is never evicted by its own
 * admission pass, even if it alone exceeds the budget: dropping it would only
 * force an immediate re-fetch on the very next request for that id.
 */
export class AudioBlobCache {
  private readonly entries = new Map<string, { promise: Promise<Blob>; bytes: number }>();
  private residentBytes = 0;

  constructor(private readonly budgetBytes: number = AUDIO_BLOB_CACHE_BUDGET_BYTES) {}

  /** A cache hit (pending or resolved); touches recency. `undefined` on a miss or eviction. */
  get(id: string): Promise<Blob> | undefined {
    const hit = this.entries.get(id);
    if (!hit) return undefined;
    // Touch: move to the most-recently-used end.
    this.entries.delete(id);
    this.entries.set(id, hit);
    return hit.promise;
  }

  /** Register an in-flight (or already-settled) fetch for `id`. */
  set(id: string, promise: Promise<Blob>): void {
    this.delete(id);
    const entry = { promise, bytes: 0 };
    this.entries.set(id, entry);
    void promise.then(
      (blob) => {
        // Deleted or superseded (a newer fetch for the same id landed) while
        // this one was in flight — do not resurrect or double-count it.
        if (this.entries.get(id) !== entry) return;
        entry.bytes = blob.size;
        this.residentBytes += blob.size;
        this.evict(id);
      },
      () => {
        // Same guard as above, for the reject path: a STALE promise (a retry
        // already replaced it with a newer `set()` for this id) failing later
        // must not delete the newer, healthy entry.
        if (this.entries.get(id) !== entry) return;
        this.delete(id);
      },
    );
  }

  delete(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.residentBytes -= entry.bytes;
    if (this.residentBytes < 0) this.residentBytes = 0;
  }

  /** For tests and debugging only. */
  stats(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.residentBytes };
  }

  /**
   * Drop least-recently-used entries until back within budget.
   *
   * Two kinds of entry are never taken: `keepId` — the entry that just
   * triggered this pass — and any entry still PENDING (`bytes === 0`, its
   * fetch has not resolved yet). Evicting a pending entry frees nothing (it
   * has not been charged to the budget yet), so it would only discard the
   * cache's reference to that in-flight promise — the next `get()` for that
   * id would then miss and start a duplicate fetch, while the orphaned first
   * fetch finishes, arrives, and is silently dropped on the floor.
   */
  private evict(keepId: string): void {
    for (const [id, entry] of this.entries) {
      if (this.residentBytes <= this.budgetBytes) break;
      if (id === keepId || entry.bytes === 0) continue;
      this.entries.delete(id);
      this.residentBytes -= entry.bytes;
    }
    if (this.residentBytes < 0) this.residentBytes = 0;
  }
}

const errorText = async (r: Response): Promise<string> => {
  try {
    const body = (await r.json()) as { detail?: unknown };
    if (typeof body?.detail === 'string') return body.detail;
    if (body?.detail) return JSON.stringify(body.detail);
  } catch {
    /* fall through */
  }
  return `HTTP ${r.status} ${r.statusText}`;
};

export class BackendLocalProvider implements StorageProvider {
  readonly name = 'backend-local';
  private readonly base: string;
  private readonly blobCache: AudioBlobCache;

  constructor(base: string = DEFAULT_BASE, blobCacheBudgetBytes: number = AUDIO_BLOB_CACHE_BUDGET_BYTES) {
    this.base = base.replace(/\/$/, '');
    this.blobCache = new AudioBlobCache(blobCacheBudgetBytes);
  }

  async list(): Promise<LibraryEntry[]> {
    const r = await fetch(`${this.base}/entries`);
    if (!r.ok) throw new Error(`library.list: ${await errorText(r)}`);
    const body = (await r.json()) as { entries: ServerRecord[] };
    return (body.entries ?? []).map(toEntry);
  }

  async get(id: string): Promise<LibraryEntry | null> {
    const r = await fetch(`${this.base}/entries/${encodeURIComponent(id)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`library.get(${id}): ${await errorText(r)}`);
    return toEntry((await r.json()) as ServerRecord);
  }

  async import(req: ImportRequest): Promise<LibraryEntry> {
    const form = new FormData();
    form.append('file', req.blob, req.filename);
    const metaPayload: Record<string, unknown> = {};
    if (req.metadata) {
      const m = req.metadata;
      if (m.title !== undefined) metaPayload.title = m.title;
      if (m.prompt !== undefined) metaPayload.prompt = m.prompt;
      if (m.negativePrompt !== undefined) metaPayload.negative_prompt = m.negativePrompt;
      if (m.model !== undefined) metaPayload.model = m.model;
      if (m.duration !== undefined) metaPayload.duration = m.duration;
      if (m.steps !== undefined) metaPayload.steps = m.steps;
      if (m.cfg !== undefined) metaPayload.cfg = m.cfg;
      if (m.seed !== undefined) metaPayload.seed = m.seed;
      if (m.source !== undefined) metaPayload.source = m.source;
      if (m.tags !== undefined) metaPayload.tags = m.tags;
      if (m.chimeraSources !== undefined) metaPayload.chimera_sources = m.chimeraSources;
    }
    form.append('metadata', JSON.stringify(metaPayload));

    const r = await fetch(`${this.base}/import`, { method: 'POST', body: form });
    if (!r.ok) throw new Error(`library.import: ${await errorText(r)}`);
    return toEntry((await r.json()) as ServerRecord);
  }

  async update(id: string, patch: LibraryEntryPatch): Promise<LibraryEntry> {
    const r = await fetch(`${this.base}/entries/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patchToServerKeys(id, patch)),
    });
    if (!r.ok) throw new Error(`library.update(${id}): ${await errorText(r)}`);
    return toEntry((await r.json()) as ServerRecord);
  }

  async delete(id: string): Promise<void> {
    const r = await fetch(`${this.base}/entries/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!r.ok && r.status !== 404) {
      throw new Error(`library.delete(${id}): ${await errorText(r)}`);
    }
  }

  getAudioUrl(entry: LibraryEntry): string {
    return entry.audioUrl;
  }

  async fetchAudioBlob(entry: LibraryEntry): Promise<Blob> {
    const cached = this.blobCache.get(entry.id);
    if (cached) return cached;
    // Resilient fetch: the single-worker backend can stall mid-stream while it
    // loads a model, dropping a large audio response even after a 200. Short
    // retries ride over that window instead of surfacing "Failed to fetch".
    const promise = fetchBlobWithRetry(entry.audioUrl, { label: entry.title || entry.id });
    // AudioBlobCache.set() already removes this entry on rejection (guarded
    // against a stale promise that lost a race with a newer `set()` for the
    // same id) — no separate cleanup needed here.
    this.blobCache.set(entry.id, promise);
    return promise;
  }
}

let _provider: StorageProvider | null = null;

export const getStorageProvider = (): StorageProvider => {
  if (_provider === null) {
    _provider = new BackendLocalProvider();
  }
  return _provider;
};

/** Tests / future settings UI can swap the active provider. */
export const setStorageProvider = (provider: StorageProvider): void => {
  _provider = provider;
};

/* ══════════════════════════ paged / searchable list ══════════════════════════
 *
 * `GET /api/library/entries` gained optional `limit` / `offset` / `q` / `sort` /
 * `kind` / `favorite` / `source` parameters, and answers a paged request with
 * `{entries, total, offset, limit, revision}`. WITHOUT `limit` it behaves
 * exactly as it always did, so every other caller is untouched.
 *
 * These are free functions rather than `StorageProvider` methods on purpose:
 * paging is a property of THIS backend, not of the storage abstraction, and a
 * future cloud provider will page differently. The store feature-detects the
 * backend from the shape of the first answer (see `LibraryListResult`).
 */

/** Rows per page. One page is one request; the store keeps an LRU of them. */
export const LIBRARY_PAGE_SIZE = 200;

/** The server caps `/entries/ids`; above this it answers 413 instead. */
export const LIBRARY_ID_CAP = 50_000;

/** The sort orders the backend understands. */
export type LibraryServerSort =
  | 'created_desc'
  | 'created_asc'
  | 'title_asc'
  | 'title_desc'
  | 'plays_desc'
  | 'duration_desc'
  | 'duration_asc'
  /** Starred rows first, then the rest, each by name (the EDIT picker's order). */
  | 'favorites_first';

/** The filter/sort state a paged request is made of. */
export interface LibraryQuery {
  /** Free-text search; '' means no text filter. */
  q: string;
  sort: LibraryServerSort;
  /** 'audio' (the historical default), 'media', 'video', 'image' or 'all'. */
  kind: string;
  /** true = favorites only. false/null = no favorite filter. */
  favorite: boolean | null;
  /** 'generate' | 'studio' | 'import', or null for any source. */
  source: string | null;
  /**
   * A detected-provider slug ('suno', …), or null for any provider. Applied by
   * the server so it covers the WHOLE library, not the rows already loaded.
   */
  provider: string | null;
}

export const DEFAULT_LIBRARY_QUERY: LibraryQuery = {
  q: '',
  sort: 'created_desc',
  kind: 'audio',
  favorite: null,
  source: null,
  provider: null,
};

/**
 * The same query with every row-narrowing filter cleared — the text, the
 * favourites toggle, the source AND the provider — keeping only the media
 * kind (and the sort, which narrows nothing).
 *
 * This is what a COUNT is asked over: "how many imports are there" has to
 * count imports in the whole library of that kind, not imports that also
 * happen to match whatever the user has typed or picked. Every filter belongs
 * in this list, so a new one cannot be forgotten at one call site and leak a
 * wrong number into a sidebar or a delete confirmation.
 */
export const plainLibraryQuery = (query: LibraryQuery): LibraryQuery => ({
  ...query,
  q: '',
  favorite: null,
  source: null,
  provider: null,
});

/** One page of a paged result set. */
export interface LibraryPage {
  entries: LibraryEntry[];
  /** Rows matching the query, across every page. */
  total: number;
  offset: number;
  limit: number;
  /** The `library_revision` the page was read at. */
  revision: number;
  /**
   * A searched page's `search_index`, or null when the page was not searched
   * (or the backend does not say). `complete: false` means the search index
   * is still being built and the page covers the indexed entries only.
   */
  searchIndex?: LibrarySearchCoverage | null;
}

/**
 * What a list request came back as.
 *
 * `paged` is the feature detection: a backend that understands `limit` answers
 * with a numeric `total`, and one that predates it ignores the parameter and
 * answers with the whole library. The unpaged answer is handed back rather than
 * thrown away, so the fallback costs ONE request, not two.
 */
export interface LibraryListResult {
  /** True when the backend understood `limit` and answered one page. */
  paged: boolean;
  /** The page, when `paged`; null otherwise. */
  page: LibraryPage | null;
  /** The whole library, when NOT `paged`; null otherwise. */
  entries: LibraryEntry[] | null;
}

/**
 * Raised by `fetchLibraryList` when the backend refuses the query's sort (400
 * naming the sort): a backend from before that sort existed. The backend has
 * no auto-reload, so a frontend that already knows a new sort can be talking
 * to one that does not; the caller picks a sort the backend has.
 */
export class LibrarySortUnsupportedError extends Error {
  readonly sort: LibraryServerSort;
  constructor(sort: LibraryServerSort, detail: string) {
    super(`library.page: ${detail}`);
    this.name = 'LibrarySortUnsupportedError';
    this.sort = sort;
  }
}

/** Raised by `fetchLibraryIds` when the filters match more ids than the cap. */
export class LibraryIdCapError extends Error {
  readonly cap: number;
  constructor(cap: number = LIBRARY_ID_CAP) {
    super(
      `Select-all is limited to ${cap.toLocaleString()} entries — narrow the search.`,
    );
    this.name = 'LibraryIdCapError';
    this.cap = cap;
  }
}

/**
 * Raised by `fetchLibraryIds` (select-all) and by a bulk delete by a searched
 * filter while the search index does not cover the library: 409 while it is
 * still being built (a search then matches only the entries indexed so far,
 * and both act on every match), 503 when the build stopped. The message is
 * the backend's, which says how far the build has got and what to do.
 */
export class LibrarySearchIndexBuildingError extends Error {
  constructor(detail: string) {
    super(detail.charAt(0).toUpperCase() + detail.slice(1));
    this.name = 'LibrarySearchIndexBuildingError';
  }
}

/**
 * The `LibrarySearchIndexBuildingError` a refusal carrying `search_index`
 * describes, or null for any other response. Reads a clone of the body.
 */
async function searchIndexRefusalFrom(r: Response): Promise<LibrarySearchIndexBuildingError | null> {
  if (r.status !== 409 && r.status !== 503) return null;
  try {
    const body = (await r.clone().json()) as { detail?: unknown; search_index?: unknown };
    if (!body || typeof body !== 'object' || !body.search_index || typeof body.detail !== 'string') return null;
    return new LibrarySearchIndexBuildingError(body.detail);
  } catch {
    return null;
  }
}

/** The query as URL parameters. Absent filters are omitted, never sent empty. */
const queryParams = (query: LibraryQuery): URLSearchParams => {
  const params = new URLSearchParams();
  if (query.kind) params.set('kind', query.kind);
  if (query.q.trim()) params.set('q', query.q.trim());
  if (query.sort) params.set('sort', query.sort);
  if (query.favorite === true) params.set('favorite', 'true');
  if (query.source) params.set('source', query.source);
  if (query.provider) params.set('provider', query.provider);
  return params;
};

/** A paged body has a numeric `total`; anything else is the old shape. */
const asPage = (body: unknown): LibraryPage | null => {
  if (!body || typeof body !== 'object') return null;
  const b = body as {
    entries?: unknown;
    total?: unknown;
    offset?: unknown;
    limit?: unknown;
    revision?: unknown;
    search_index?: unknown;
  };
  if (typeof b.total !== 'number' || !Number.isFinite(b.total)) return null;
  if (!Array.isArray(b.entries)) return null;
  return {
    entries: (b.entries as ServerRecord[]).map(toEntry),
    total: b.total,
    offset: typeof b.offset === 'number' ? b.offset : 0,
    limit: typeof b.limit === 'number' ? b.limit : LIBRARY_PAGE_SIZE,
    revision: typeof b.revision === 'number' ? b.revision : 0,
    searchIndex: asSearchCoverage(b.search_index),
  };
};

/** The rows out of an OLD (unpaged) `/entries` answer, or a bare array. */
const asEntryList = (body: unknown): LibraryEntry[] => {
  if (Array.isArray(body)) return (body as ServerRecord[]).map(toEntry);
  if (body && typeof body === 'object') {
    const rows = (body as { entries?: unknown }).entries;
    if (Array.isArray(rows)) return (rows as ServerRecord[]).map(toEntry);
  }
  return [];
};

/**
 * One page of the library, or — against a backend that has no paging — the
 * whole library in one answer. `signal` aborts an in-flight page whose query
 * the user has already moved on from.
 */
export async function fetchLibraryList(
  query: LibraryQuery,
  offset: number,
  limit: number,
  signal?: AbortSignal,
  base: string = DEFAULT_BASE,
): Promise<LibraryListResult> {
  const params = queryParams(query);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  const r = await fetch(`${base}/entries?${params.toString()}`, { signal });
  if (!r.ok) {
    // 503 while the library is still opening: the caller shows the progress.
    const opening = await openingErrorFrom(r);
    if (opening) throw opening;
    const detail = await errorText(r);
    if (r.status === 400 && detail.startsWith('sort must be one of')) {
      throw new LibrarySortUnsupportedError(query.sort, detail);
    }
    throw new Error(`library.page: ${detail}`);
  }
  const body: unknown = await r.json();
  const page = asPage(body);
  if (page) return { paged: true, page, entries: null };
  return { paged: false, page: null, entries: asEntryList(body) };
}

/** What `fetchLibraryIds` answers. */
export interface LibraryIdsResult {
  ids: string[];
  total: number;
  /**
   * A searched answer's `search_index`: `complete: false` while the search
   * index is still being built, when `ids` are the matches indexed so far
   * (only a `partial` request gets that answer). Null when not searched.
   */
  searchIndex: LibrarySearchCoverage | null;
}

/**
 * Every id matching `query`, in the query's own order — what select-all and a
 * shift-range need without loading a single row.
 *
 * `partial` is for callers that follow the list on screen (play the list, a
 * shift-click range, revealing a track): while the search index is still
 * being built they get the ids the list shows. Without it (select-all) a
 * search then throws `LibrarySearchIndexBuildingError`.
 *
 * Throws `LibraryIdCapError` when the backend refuses (413),
 * `LibraryOpeningError` while the library is still opening (503), and returns
 * null when the route does not exist at all (an older backend), which tells
 * the caller to fall back to the rows it already holds.
 */
export async function fetchLibraryIds(
  query: LibraryQuery,
  signal?: AbortSignal,
  base: string = DEFAULT_BASE,
  options: { partial?: boolean } = {},
): Promise<LibraryIdsResult | null> {
  const params = queryParams(query);
  if (options.partial) params.set('partial', 'true');
  const r = await fetch(`${base}/entries/ids?${params.toString()}`, { signal });
  if (r.status === 413) throw new LibraryIdCapError();
  if (r.status === 404 || r.status === 405) return null;
  if (!r.ok) {
    const opening = await openingErrorFrom(r);
    if (opening) throw opening;
    const refusal = await searchIndexRefusalFrom(r);
    if (refusal) throw refusal;
    throw new Error(`library.ids: ${await errorText(r)}`);
  }
  const body = (await r.json()) as { ids?: unknown; total?: unknown; search_index?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === 'string') : [];
  return {
    ids,
    total: typeof body.total === 'number' ? body.total : ids.length,
    searchIndex: asSearchCoverage(body.search_index),
  };
}

/* ════════════════════════════ facets ═══════════════════════════════════════
 *
 * `GET /api/library/entries/facets?fields=model,provider&<the page filters>`
 * answers `{facets: {model: [{value, count}, …], …}, revision}`. The values are
 * the DISTINCT values across the whole result set, so a filter dropdown offers
 * every model in a 200,000-entry library rather than the handful on the rows
 * that happen to be loaded. A backend without the route answers 404, and every
 * caller falls back to the rows in hand.
 */

/** The facet answer, already narrowed to the values the UI can use. */
export interface LibraryFacetsResult {
  facets: LibraryFacets;
  /** The `library_revision` the counts were read at; 0 when unknown. */
  revision: number;
}

/**
 * `[{value, count}]`, dropping anything that is not that shape.
 *
 * `value` is a string when the server sent one, and `null` for everything
 * else — the empty bucket (a genuine `null`), a missing field, or any
 * malformed value (a number, an object, ...) the server should never send but
 * that must not crash the filter dropdown. Exported for direct testing.
 */
export const asFacetValues = (raw: unknown): LibraryFacetValue[] => {
  if (!Array.isArray(raw)) return [];
  const out: LibraryFacetValue[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const v = item as { value?: unknown; count?: unknown };
    const value = typeof v.value === 'string' ? v.value : null;
    const count = typeof v.count === 'number' && Number.isFinite(v.count) ? v.count : 0;
    out.push({ value, count });
  }
  return out;
};

/**
 * The distinct values of each field across everything `query` matches.
 *
 * Returns null when the backend has no facets route (404/405) — the caller
 * keeps whatever it derived from the loaded rows. `sort` is deliberately not
 * sent: re-ordering a list cannot change a count, and sending it would make
 * every sort change a cache miss.
 */
export async function fetchLibraryFacets(
  fields: readonly LibraryFacetField[],
  query: LibraryQuery,
  signal?: AbortSignal,
  base: string = DEFAULT_BASE,
): Promise<LibraryFacetsResult | null> {
  if (fields.length === 0) return { facets: {}, revision: 0 };
  const params = queryParams(query);
  params.delete('sort');
  params.set('fields', fields.join(','));
  const r = await fetch(`${base}/entries/facets?${params.toString()}`, { signal });
  if (r.status === 404 || r.status === 405) return null;
  if (!r.ok) {
    // 503 while the library is still opening: not a failure to log.
    const opening = await openingErrorFrom(r);
    if (opening) throw opening;
    throw new Error(`library.facets: ${await errorText(r)}`);
  }
  const body = (await r.json()) as { facets?: unknown; revision?: unknown };
  const raw = body.facets && typeof body.facets === 'object'
    ? (body.facets as Record<string, unknown>)
    : {};
  const facets: LibraryFacets = {};
  for (const field of fields) facets[field] = asFacetValues(raw[field]);
  return {
    facets,
    revision: typeof body.revision === 'number' && Number.isFinite(body.revision) ? body.revision : 0,
  };
}

/**
 * How many rows `query` matches, without loading any of them: one page of ONE
 * row, read for its `total`. Null against a backend that does not page (which
 * has every row in hand anyway, so the caller can count them itself).
 */
export async function fetchLibraryMatchCount(
  query: LibraryQuery,
  signal?: AbortSignal,
  base: string = DEFAULT_BASE,
): Promise<number | null> {
  const result = await fetchLibraryList(query, 0, 1, signal, base);
  if (!result.paged || !result.page) return null;
  return result.page.total;
}

/* ════════════════════════════ stats ════════════════════════════════════════
 *
 * `GET /api/library/entries/stats?<the page filters>` answers
 * `{count, favorites, size_bytes, duration_sec, revision}` over EVERY row the
 * filters match, so the chips above the list describe the whole query rather
 * than the pages this client happens to hold.
 */

/** Totals over a whole query. */
export interface LibraryStats {
  count: number;
  favorites: number;
  sizeBytes: number;
  durationSec: number;
  /** The `library_revision` the totals were read at; 0 when unknown. */
  revision: number;
}

const finiteOr0 = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

/**
 * The totals of everything `query` matches. Null against a backend with no
 * stats route: an older one answers the path with its `/entries/{id}` route,
 * which is a 404, and the caller then sums the rows it holds.
 */
export async function fetchLibraryStats(
  query: LibraryQuery,
  signal?: AbortSignal,
  base: string = DEFAULT_BASE,
): Promise<LibraryStats | null> {
  const params = queryParams(query);
  params.delete('sort');
  const r = await fetch(`${base}/entries/stats?${params.toString()}`, { signal });
  if (r.status === 404 || r.status === 405) return null;
  if (!r.ok) {
    const opening = await openingErrorFrom(r);
    if (opening) throw opening;
    throw new Error(`library.stats: ${await errorText(r)}`);
  }
  const body = (await r.json()) as Record<string, unknown>;
  return {
    count: finiteOr0(body.count),
    favorites: finiteOr0(body.favorites),
    sizeBytes: finiteOr0(body.size_bytes),
    durationSec: finiteOr0(body.duration_sec),
    revision: finiteOr0(body.revision),
  };
}

/* ═════════════════════════ entry references ═══════════════════════════════
 *
 * `GET /api/library/entries/resolve?ref=` names the audio entry a LOOM score or
 * template means by an id, an id prefix or a title fragment, over the whole
 * library. `{id: null}` when nothing matches.
 */

/**
 * The entry id `ref` names, null when the library has none, or undefined
 * against a backend with no resolve route (a 404 from its `/entries/{id}`),
 * which tells the caller to look through the rows it holds instead. Throws
 * `LibraryOpeningError` while the library is still opening (503).
 */
export async function resolveLibraryEntryRef(
  ref: string,
  signal?: AbortSignal,
  base: string = DEFAULT_BASE,
): Promise<string | null | undefined> {
  const params = new URLSearchParams({ ref });
  const r = await fetch(`${base}/entries/resolve?${params.toString()}`, { signal });
  if (r.status === 404 || r.status === 405) return undefined;
  if (!r.ok) {
    const opening = await openingErrorFrom(r);
    if (opening) throw opening;
    throw new Error(`library.resolve: ${await errorText(r)}`);
  }
  const body = (await r.json()) as { id?: unknown };
  return typeof body.id === 'string' ? body.id : null;
}

/* ═════════════════════════ bulk delete ═════════════════════════════════════
 *
 * `POST /api/library/entries/bulk-delete` takes EITHER a list of ids or a
 * filter plus the count the user was shown. The server re-counts the filter and
 * refuses with 409 when its count differs, so a library that moved between the
 * confirmation and the click deletes nothing at all.
 */

/** The filter form's filter — the page query's filters, server spelling. */
export interface LibraryDeleteFilter {
  q?: string;
  kind?: string;
  /** false selects the NON-favorites; omit for no favourite filter. */
  favorite?: boolean;
  source?: string;
}

export type LibraryBulkDeleteRequest =
  | { ids: readonly string[] }
  | {
      filter: LibraryDeleteFilter;
      /** The count the user confirmed. The server refuses a different one. */
      confirmTotal: number;
      /** Required for an EMPTY filter, which would match the whole library. */
      all?: boolean;
    };

export interface LibraryBulkDeleteResult {
  deleted: number;
  /** The first failures, per id. A failure never aborts the rest of the job. */
  failed: { id: string; error: string }[];
  totalMatched: number;
  revision: number;
}

/** The server re-counted and got a different number: nothing was deleted. */
export class LibraryBulkConflictError extends Error {
  /**
   * What the server counts NOW — re-ask the user with this. `NaN` when the
   * 409 body did not say (the server should always send it, but a caller
   * that blindly trusted a fallback here would otherwise be told "0 entries
   * left" — a specific, wrong fact — instead of "unknown"). There is no list
   * of ids/entries in a 409 body to count as a substitute (see
   * `backend/modules/library/router.py`'s 409, `{detail, total_matched}`
   * only).
   */
  readonly totalMatched: number;
  constructor(message: string, totalMatched: number) {
    super(message);
    this.name = 'LibraryBulkConflictError';
    this.totalMatched = totalMatched;
  }
}

/** What a conflict-handling caller should show the user, and store. */
export interface BulkConflictNotice {
  /** Ready to hand to `window.alert` or similar — never contains "NaN". */
  message: string;
  /**
   * The re-counted total, or `null` when the server didn't say
   * (`LibraryBulkConflictError.totalMatched` was `NaN`). A caller MUST NOT
   * store `null` in place of whatever count it already had — that would
   * itself be a lie ("0 entries"/blank) as much as storing NaN would be.
   * Leave the existing stored value alone, or re-fetch, instead.
   */
  total: number | null;
}

/**
 * Turns a `LibraryBulkConflictError` into what a confirmation dialog should
 * show and store, in ONE place — so every caller (the non-favorites retry
 * loop, the Clear All confirmation) applies the same rule instead of each
 * needing its own NaN guard. `totalMatched` is `NaN` exactly when the
 * server's 409 body omitted `total_matched` (see the class doc); rendering
 * that straight into a template literal produces "It now holds NaN entries",
 * and storing it feeds the SAME NaN into the next render. Pure — no DOM, no
 * React — so it is testable on its own.
 */
export function describeBulkConflict(totalMatched: number): BulkConflictNotice {
  if (!Number.isFinite(totalMatched)) {
    return {
      message: 'The library changed while the confirmation was open — nothing was deleted.',
      total: null,
    };
  }
  return {
    message: `The library changed while the confirmation was open — nothing was deleted. It now holds ${totalMatched.toLocaleString()} entries.`,
    total: totalMatched,
  };
}

const isIdForm = (req: LibraryBulkDeleteRequest): req is { ids: readonly string[] } =>
  Object.prototype.hasOwnProperty.call(req, 'ids');

/**
 * Delete many entries in one request.
 *
 * Returns null when the backend has no bulk route (404/405), so the caller can
 * keep its one-at-a-time behaviour and its old wording. Throws
 * `LibraryBulkConflictError` on the server's 409.
 */
export async function bulkDeleteLibraryEntries(
  req: LibraryBulkDeleteRequest,
  signal?: AbortSignal,
  base: string = DEFAULT_BASE,
): Promise<LibraryBulkDeleteResult | null> {
  let body: Record<string, unknown>;
  if (isIdForm(req)) {
    // Never send an empty id list: a server that reads it as "no filter" would
    // delete the library. Nothing selected is nothing to do.
    if (req.ids.length === 0) return { deleted: 0, failed: [], totalMatched: 0, revision: 0 };
    body = { ids: [...req.ids] };
  } else {
    const filter: Record<string, unknown> = {};
    if (req.filter.q) filter.q = req.filter.q;
    if (req.filter.kind) filter.kind = req.filter.kind;
    if (req.filter.favorite !== undefined) filter.favorite = req.filter.favorite;
    if (req.filter.source) filter.source = req.filter.source;
    if (Object.keys(filter).length === 0 && req.all !== true) {
      throw new Error(
        'library.bulkDelete: an empty filter matches the whole library and needs `all: true`',
      );
    }
    body = { filter, confirm_total: req.confirmTotal };
    if (req.all === true) body.all = true;
  }

  const r = await fetch(`${base}/entries/bulk-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (r.status === 404 || r.status === 405) return null;
  // A searched filter while the search index does not cover the library: not
  // a count conflict, and there is no count to re-confirm with.
  const refusal = await searchIndexRefusalFrom(r);
  if (refusal) throw refusal;
  const opening = await openingErrorFrom(r);
  if (opening) throw opening;
  if (r.status === 409) {
    const conflict = (await r.json().catch(() => ({}))) as { detail?: unknown; total_matched?: unknown };
    const detail = typeof conflict.detail === 'string'
      ? conflict.detail
      : 'the library changed since the count you confirmed';
    const matched =
      typeof conflict.total_matched === 'number' && Number.isFinite(conflict.total_matched)
        ? conflict.total_matched
        : NaN;
    throw new LibraryBulkConflictError(detail, matched);
  }
  if (!r.ok) throw new Error(`library.bulkDelete: ${await errorText(r)}`);
  const out = (await r.json()) as {
    deleted?: unknown;
    failed?: unknown;
    total_matched?: unknown;
    revision?: unknown;
  };
  const failed = Array.isArray(out.failed)
    ? out.failed.flatMap((f) => {
        if (!f || typeof f !== 'object') return [];
        const row = f as { id?: unknown; error?: unknown };
        return typeof row.id === 'string'
          ? [{ id: row.id, error: typeof row.error === 'string' ? row.error : 'failed' }]
          : [];
      })
    : [];
  return {
    deleted: typeof out.deleted === 'number' ? out.deleted : 0,
    failed,
    totalMatched: typeof out.total_matched === 'number' ? out.total_matched : 0,
    revision: typeof out.revision === 'number' ? out.revision : 0,
  };
}

/** One entry by id, with its FULL lyrics. null when it is not in the library. */
export async function fetchLibraryEntry(
  id: string,
  signal?: AbortSignal,
  base: string = DEFAULT_BASE,
): Promise<LibraryEntry | null> {
  const r = await fetch(`${base}/entries/${encodeURIComponent(id)}`, { signal });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`library.get(${id}): ${await errorText(r)}`);
  return toEntry((await r.json()) as ServerRecord);
}

