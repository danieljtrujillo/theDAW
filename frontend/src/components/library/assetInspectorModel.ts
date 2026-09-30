/**
 * The asset inspector's pure model: everything the centered pop-out decides
 * about an asset that does not need the DOM, React, or a store.
 *
 * It owns the tab list and the sanitizing of the remembered tab, the "Unknown"
 * vocabulary (a fact the library does not hold reads "Unknown" — never an empty
 * cell, and never a zero pretending to be a duration), the grouping of an
 * entry's fields into the Overview sections, the Stems / Used-in lookups, and
 * the redaction + search of the raw metadata blob.
 *
 * Units: durations and every `*_sec` input are SECONDS; `fileSizeBytes` and
 * `sizeBytes` are BYTES; sample rates are HERTZ; `lastPlayedAt` is UNIX
 * SECONDS. Formatters never throw on a bad number: a non-finite, negative or
 * wrong-typed value is exactly the "we do not know this" case the dialog
 * exists to state plainly, so it degrades to `UNKNOWN` instead.
 */

/* ------------------------------------------------------------------ tabs */

export type InspectorTab = 'overview' | 'stems' | 'lineage' | 'usedIn' | 'raw';

export interface InspectorTabSpec {
  readonly id: InspectorTab;
  readonly label: string;
}

/** The dialog's tabs, in the order they are shown. */
export const INSPECTOR_TABS: readonly InspectorTabSpec[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'stems', label: 'Stems' },
  { id: 'lineage', label: 'Lineage' },
  { id: 'usedIn', label: 'Used in' },
  { id: 'raw', label: 'Raw metadata' },
];

/** Where the last-used tab is remembered between openings. */
export const ASSET_INSPECTOR_TAB_STORAGE_KEY = 'thedaw.assetinspector.tab.v1';

const TAB_BY_LOWER: ReadonlyMap<string, InspectorTab> = new Map(
  INSPECTOR_TABS.map((t) => [t.id.toLowerCase(), t.id]),
);

/**
 * The tab a stored/incoming value names, or `fallback` when it names none.
 * Guards against an id from an older build, a hand-edited localStorage value
 * and a value of the wrong type alike — a bad value must never leave the
 * dialog showing no panel at all.
 */
export function sanitizeTab(raw: unknown, fallback: InspectorTab = 'overview'): InspectorTab {
  const safeFallback = typeof fallback === 'string' && TAB_BY_LOWER.has(fallback.toLowerCase())
    ? TAB_BY_LOWER.get(fallback.toLowerCase())!
    : 'overview';
  if (typeof raw !== 'string') return safeFallback;
  return TAB_BY_LOWER.get(raw.trim().toLowerCase()) ?? safeFallback;
}

/**
 * The tab a tablist key press moves to, or null when the tablist does not own
 * that key (so Escape, Tab and typing reach the rest of the dialog). Left and
 * right wrap around the ends, as the ARIA tabs pattern expects.
 */
export function tabAfterKey(current: InspectorTab, key: string): InspectorTab | null {
  const n = INSPECTOR_TABS.length;
  const at = INSPECTOR_TABS.findIndex((t) => t.id === current);
  const from = at < 0 ? 0 : at;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return INSPECTOR_TABS[(from + 1) % n].id;
    case 'ArrowLeft':
    case 'ArrowUp':
      return INSPECTOR_TABS[(from - 1 + n) % n].id;
    case 'Home':
      return INSPECTOR_TABS[0].id;
    case 'End':
      return INSPECTOR_TABS[n - 1].id;
    default:
      return null;
  }
}

/* ------------------------------------------------------------ formatting */

/** What the inspector says instead of leaving a fact blank. */
export const UNKNOWN = 'Unknown';

/**
 * A value as a reader should see it, or `UNKNOWN` when the library does not
 * hold it. Zero and `false` are facts and survive; an empty string, an empty
 * list and a non-finite number are absences.
 */
export function formatUnknown(value: unknown): string {
  if (value === null || value === undefined) return UNKNOWN;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : UNKNOWN;
  if (Array.isArray(value)) {
    const parts = value
      .map((v) => (v === null || v === undefined ? '' : String(v).trim()))
      .filter((s) => s.length > 0);
    return parts.length > 0 ? parts.join(', ') : UNKNOWN;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : UNKNOWN;
}

/**
 * A length in SECONDS as `m:ss` (or `h:mm:ss` past the hour). A missing,
 * zero, negative or non-numeric length reads `UNKNOWN`: a track whose duration
 * was never measured must not be shown as 0:00.
 */
export function formatDurationLabel(seconds: unknown): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return UNKNOWN;
  const whole = Math.floor(seconds);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** A sample rate in HERTZ as kHz ("44.1 kHz"), or `UNKNOWN`. */
export function formatSampleRate(hz: unknown): string {
  if (typeof hz !== 'number' || !Number.isFinite(hz) || hz <= 0) return UNKNOWN;
  const khz = hz / 1000;
  const text = Number.isInteger(khz) ? String(khz) : khz.toFixed(1).replace(/\.0$/, '');
  return `${text} kHz`;
}

/** A channel count as words ("Mono", "Stereo", "6 channels"), or `UNKNOWN`. */
export function formatChannels(count: unknown): string {
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) return UNKNOWN;
  if (count === 1) return 'Mono';
  if (count === 2) return 'Stereo';
  return `${count} channels`;
}

/** A file size in BYTES, matching the library's existing B / KB / MB steps. */
export function formatBytes(bytes: unknown): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return UNKNOWN;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

/** An ISO timestamp in the reader's locale, or `UNKNOWN` when unparseable. */
export function formatDateLabel(iso: unknown): string {
  if (typeof iso !== 'string' || iso.trim().length === 0) return UNKNOWN;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return UNKNOWN;
  return d.toLocaleString();
}

/** A UNIX-SECONDS stamp in the reader's locale, or `UNKNOWN`. */
export function formatUnixSeconds(seconds: unknown): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return UNKNOWN;
  const d = new Date(seconds * 1000);
  if (Number.isNaN(d.getTime())) return UNKNOWN;
  return d.toLocaleString();
}

function formatNumber(value: unknown, digits: number, unit = ''): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UNKNOWN;
  return `${value.toFixed(digits)}${unit}`;
}

/* -------------------------------------------------------- field grouping */

export interface InspectorField {
  readonly label: string;
  readonly value: string;
  /** The value carries line breaks the view must preserve (lyrics, prompts). */
  readonly multiline?: boolean;
}

export interface InspectorFieldGroup {
  readonly title: string;
  readonly fields: readonly InspectorField[];
}

/**
 * The subset of a `LibraryEntry` the inspector reads. Declared structurally so
 * this module stays free of the store: a `LibraryEntry` satisfies it as-is.
 */
export interface InspectorEntryFacts {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly negativePrompt: string;
  readonly model: string;
  /** SECONDS. */
  readonly duration: number;
  readonly steps: number;
  readonly cfg: number;
  readonly seed: number;
  readonly mimeType: string;
  /** BYTES. */
  readonly fileSizeBytes: number;
  readonly timestamp: string;
  readonly favorite: boolean;
  readonly rating: 'like' | 'dislike' | null;
  readonly tags: readonly string[];
  readonly notes: string;
  readonly lyrics: string;
  readonly source: string;
  readonly kind?: string;
  readonly audioFilename?: string;
  readonly playCount?: number;
  /** UNIX SECONDS, or null when never played. */
  readonly lastPlayedAt?: number | null;
  readonly analysis?: Record<string, unknown>;
  readonly chimeraSources?: readonly string[];
}

/** Extra facts the dialog resolves outside the entry record. */
export interface OverviewExtras {
  /** `deriveStyle(entry)` — the Suno-style/genre text, when there is one. */
  readonly style?: string;
  /** `deriveLyrics(entry)` — falls back to tags/notes for legacy imports. */
  readonly lyrics?: string;
}

/**
 * The header's technical facts, always the same six rows in the same order so
 * the dialog's shape does not shift between assets. Anything the library does
 * not hold reads `UNKNOWN`.
 */
export function headerFacts(entry: InspectorEntryFacts): readonly InspectorField[] {
  const a = entry.analysis ?? {};
  const format = a.container ?? a.codec ?? entry.mimeType;
  return [
    { label: 'Kind', value: formatUnknown(entry.kind ?? 'audio') },
    { label: 'Duration', value: formatDurationLabel(entry.duration) },
    { label: 'Format', value: formatUnknown(format) },
    { label: 'Sample rate', value: formatSampleRate(a.sample_rate) },
    { label: 'Channels', value: formatChannels(a.channels) },
    { label: 'Size', value: formatBytes(entry.fileSizeBytes) },
  ];
}

/**
 * The Overview tab's sections. A section in which every single field is
 * `UNKNOWN` is dropped — a wall of "Unknown" tells the reader nothing that the
 * section's absence does not.
 */
export function overviewGroups(
  entry: InspectorEntryFacts,
  extras: OverviewExtras = {},
): readonly InspectorFieldGroup[] {
  const a = entry.analysis ?? {};
  const lyrics = extras.lyrics ?? entry.lyrics;
  const key = a.key ? `${String(a.key)} ${a.scale ? String(a.scale) : ''}`.trim() : null;

  const groups: InspectorFieldGroup[] = [
    {
      title: 'Dates',
      fields: [
        { label: 'Created', value: formatDateLabel(entry.timestamp) },
        { label: 'Last played', value: formatUnixSeconds(entry.lastPlayedAt) },
        { label: 'Plays', value: formatUnknown(entry.playCount) },
      ],
    },
    {
      title: 'Prompt',
      fields: [
        { label: 'Prompt', value: formatUnknown(entry.prompt), multiline: true },
        { label: 'Negative prompt', value: formatUnknown(entry.negativePrompt), multiline: true },
        { label: 'Style', value: formatUnknown(extras.style) },
      ],
    },
    {
      title: 'Lyrics',
      fields: [{ label: 'Lyrics', value: formatUnknown(lyrics), multiline: true }],
    },
    {
      title: 'Generation',
      fields: [
        { label: 'Model', value: formatUnknown(entry.model) },
        { label: 'Source', value: formatUnknown(entry.source) },
        { label: 'Seed', value: entry.seed === -1 ? 'random' : formatUnknown(entry.seed) },
        { label: 'Steps', value: formatUnknown(entry.steps) },
        { label: 'CFG', value: formatNumber(entry.cfg, 2) },
        { label: 'File', value: formatUnknown(entry.audioFilename) },
        { label: 'Type', value: formatUnknown(entry.mimeType) },
      ],
    },
    {
      title: 'Analysis',
      fields: [
        { label: 'BPM', value: formatNumber(a.bpm, 1) },
        { label: 'Key', value: formatUnknown(key) },
        { label: 'Loudness', value: formatNumber(a.loudness_lufs, 1, ' LUFS') },
        { label: 'Bars', value: formatNumber(a.bars_estimated, 1) },
        { label: 'Genre', value: formatUnknown(a.genre) },
      ],
    },
    {
      title: 'Library',
      fields: [
        { label: 'Tags', value: formatUnknown(entry.tags) },
        { label: 'Rating', value: formatUnknown(entry.rating) },
        { label: 'Favorite', value: formatUnknown(entry.favorite) },
        { label: 'Notes', value: formatUnknown(entry.notes), multiline: true },
      ],
    },
  ];

  return groups.filter((g) => g.fields.some((f) => f.value !== UNKNOWN));
}

/* --------------------------------------------------------- raw metadata */

/** What a redacted value is replaced with. */
export const REDACTED = '[redacted]';

/** What a signed URL's query string is replaced with. */
export const SIGNED_QUERY_REMOVED = '[signed query removed]';

const SECRET_KEY_RE = /cookie|token|authorization|secret|password|signature/i;

/** Query parameters that mark a URL as signed / credential-bearing. */
const SIGNED_PARAM_RE =
  /^(?:x-(?:amz|goog|ms)-|amz-)|^(?:sig|signature|hmac|token|access_token|id_token|expires|expiry|policy|credential|awsaccesskeyid|key|verify|se|sp|sv|sr|st|skoid|sktid)$/i;

/** True when a metadata key's VALUE must never be shown. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/**
 * A URL-shaped string with its signed query string removed. Ordinary query
 * strings and ordinary prose (which may contain a question mark) are returned
 * untouched — only a URL or absolute path whose query carries a signature,
 * token or expiry loses it.
 */
export function stripSignedQuery(text: string): string {
  const q = text.indexOf('?');
  if (q < 0) return text;
  const base = text.slice(0, q);
  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(base) || base.startsWith('/');
  if (!looksLikeUrl) return text;
  const query = text.slice(q + 1).split('#')[0];
  const signed = query
    .split('&')
    .some((pair) => SIGNED_PARAM_RE.test(decodeURIComponent(pair.split('=')[0] ?? '')));
  return signed ? `${base}?${SIGNED_QUERY_REMOVED}` : text;
}

/**
 * A metadata payload safe to show and copy: every value under a key that names
 * a cookie, token, authorization header, secret, password or signature is
 * replaced, and every signed URL loses its query string. Cycles are reported
 * rather than followed, so a self-referencing payload cannot hang the dialog.
 */
export function redactSecrets(value: unknown): unknown {
  return redactInner(value, new WeakSet<object>());
}

function redactInner(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return stripSignedQuery(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactInner(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretKey(k) ? REDACTED : redactInner(v, seen);
  }
  return out;
}

/**
 * A payload as pretty JSON with `redactSecrets` already applied — the only
 * way this module renders raw metadata, so no call site can forget it.
 */
export function toRedactedJson(value: unknown): string {
  try {
    return JSON.stringify(redactSecrets(value), null, 2) ?? String(value);
  } catch {
    // BigInt and other non-serializable leaves: say so rather than blank out.
    return '[this metadata could not be rendered as JSON]';
  }
}

export interface JsonFilterResult {
  /** The lines that matched, joined; the whole text when the search is empty. */
  readonly text: string;
  readonly matched: number;
  readonly total: number;
}

/**
 * The lines of a pretty-printed payload that contain `query`, case-insensitive.
 * An empty or whitespace-only query is no search at all and returns everything.
 */
export function filterPrettyJson(pretty: string, query: string): JsonFilterResult {
  const lines = pretty.split('\n');
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return { text: pretty, matched: lines.length, total: lines.length };
  const hits = lines.filter((line) => line.toLowerCase().includes(needle));
  return { text: hits.join('\n'), matched: hits.length, total: lines.length };
}

/* ---------------------------------------------------------------- stems */

/** One row of `/api/library/_all/stems`, as far as the inspector reads it. */
export interface StemRow {
  readonly id?: unknown;
  /** The PARENT entry's id — the stems table keys stems by their parent. */
  readonly entry_id?: unknown;
  readonly parent_id?: unknown;
  readonly stem_name?: unknown;
  readonly model?: unknown;
  readonly file_size_bytes?: unknown;
}

export interface InspectorStem {
  readonly id: string;
  readonly name: string;
  readonly model: string | null;
  /** BYTES, or null when the row does not carry a size. */
  readonly sizeBytes: number | null;
}

/** This parent's stems, by name. Rows without a usable id are skipped. */
export function stemsOfParent(rows: readonly StemRow[], parentId: string): readonly InspectorStem[] {
  if (!parentId) return [];
  const out: InspectorStem[] = [];
  for (const row of rows) {
    const parent = row.entry_id ?? row.parent_id;
    if (typeof parent !== 'string' || parent !== parentId) continue;
    const id = typeof row.id === 'string' ? row.id : '';
    if (!id) continue;
    out.push({
      id,
      name: typeof row.stem_name === 'string' && row.stem_name ? row.stem_name : 'stem',
      model: typeof row.model === 'string' && row.model ? row.model : null,
      sizeBytes: typeof row.file_size_bytes === 'number' && Number.isFinite(row.file_size_bytes)
        ? row.file_size_bytes
        : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** One lineage edge, as far as the inspector reads it. */
export interface InspectorEdge {
  readonly from_id: string;
  readonly to_id: string;
  readonly kind: string;
}

/**
 * The parent of an entry that IS a stem, from the incoming `stem_of` edge the
 * separator records (parent → stem). Null for anything else, including the
 * parent side of that same edge.
 */
export function stemParentId(edges: readonly InspectorEdge[], entryId: string): string | null {
  if (!entryId) return null;
  const edge = edges.find((e) => e.kind === 'stem_of' && e.to_id === entryId);
  return edge ? edge.from_id : null;
}

/* -------------------------------------------------------------- used in */

/** A setlist, as far as the inspector reads it (`state/setlistStore`). */
export interface InspectorSetlist {
  readonly id: string;
  readonly name: string;
  readonly entries: readonly { readonly entryId: string | null }[];
}

export interface SetlistReference {
  readonly id: string;
  readonly name: string;
  /** 1-based slot numbers, so the reader can find the track in the set. */
  readonly positions: readonly number[];
}

/** The setlists that name this entry, in the order the sets were given. */
export function setlistsReferencing(
  setlists: readonly InspectorSetlist[],
  entryId: string,
): readonly SetlistReference[] {
  if (!entryId) return [];
  const out: SetlistReference[] = [];
  for (const set of setlists) {
    const positions: number[] = [];
    set.entries.forEach((e, i) => {
      if (e.entryId === entryId) positions.push(i + 1);
    });
    if (positions.length > 0) out.push({ id: set.id, name: set.name, positions });
  }
  return out;
}
