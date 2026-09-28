/**
 * The client for `/api/lineage-scale` — the four read-only GET routes that let
 * a 200,000-song library be explored one neighbourhood at a time instead of
 * drawn all at once.
 *
 * Everything here is URL building plus `getJson`, so the pairing header goes
 * out with every request (see `lib/apiJson.ts`) and a FastAPI `{detail}` comes
 * back as the thrown message. The clamps are the contract's own limits applied
 * BEFORE the request: a slider that has gone out of range must not turn into a
 * 422, and a budget the UI cannot draw must not be asked for.
 *
 * Nothing in this module loads the library. `fetchNeighbourhood` is the only
 * graph read, it is bounded by `budget`, and the landing page reads two small
 * summaries. That is the whole point of the module.
 */
import { describeApiError, getJson, pairingHeaderFor } from '../lib/apiJson';

/** Route prefix. Relative, so it goes through the Vite proxy to :8600. */
export const LINEAGE_SCALE_BASE = '/api/lineage-scale';

/* ────────────────────────────── contract limits ──────────────────────────── */

/** Generations up/down a neighbourhood request may ask for. */
export const DEPTH_MIN = 0;
export const DEPTH_MAX = 8;
/** Nodes a neighbourhood may contain before the server truncates. */
export const BUDGET_MIN = 50;
export const BUDGET_MAX = 1500;
/** Rows one `relatives` page may hold. */
export const RELATIVES_LIMIT_MAX = 500;
/**
 * Rows one ranked list may hold. The contract documents `limit=50` and sets no
 * ceiling; this is a client-side guard so a bad caller cannot ask the server
 * for an unbounded list, not a claim about the route.
 */
export const RANKING_LIMIT_MAX = 200;

/** A finite integer inside [lo, hi]; anything else becomes `fallback`. */
export const clampInt = (value: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
};

export const clampDepth = (value: unknown, fallback: number): number =>
  clampInt(value, DEPTH_MIN, DEPTH_MAX, fallback);

export const clampBudget = (value: unknown, fallback = 400): number =>
  clampInt(value, BUDGET_MIN, BUDGET_MAX, fallback);

/* ─────────────────────────────── wire shapes ─────────────────────────────── */

/**
 * What a relation MEANS, decided once on the backend (`graph.py`) and carried
 * on every edge so the UI never has to guess:
 *   * `ancestry` — one song came from another; walked across generations.
 *   * `uses` — a cross-reference (a mashup uses A and B). One hop only, never
 *     walked through, so a neighbourhood cannot leak into an unrelated tree.
 *   * `artifact` — a MIDI/notation/chord rendering. Counted, never a node.
 *   * `other` — a kind this build has not classified. One hop, never recursed.
 */
export type LinkRole = 'ancestry' | 'uses' | 'artifact' | 'other';

export interface LineageSummary {
  entries: number;
  with_lineage: number;
  standalone: number;
  /** Rows in `relations`, duplicates and all. */
  links_raw: number;
  /** Distinct (child, parent) pairs — what the graph actually has edges for. */
  links_distinct: number;
  by_kind: Record<string, number>;
  /** Largest connected component over every role. */
  largest_connected: number;
  /** Largest component over `ancestry` links only — the largest real family. */
  largest_tree: number;
  /** True when LEARN opens the classic drawing by default
   *  (with_lineage <= full_view_limit). */
  full_view_ok: boolean;
  /** The `with_lineage` count `full_view_ok` is decided against. Absent on
   *  older backends that did not send it. */
  full_view_limit?: number;
  revision: number;
  /**
   * True when this answer came from the cache; false means this request ran
   * the pass. Absent on older backends that did not report it.
   */
  warm?: boolean;
}

export type RankingList = 'most_derived' | 'deepest' | 'mashup_sources' | 'recent';

export const RANKING_LISTS: readonly RankingList[] = [
  'most_derived',
  'deepest',
  'mashup_sources',
  'recent',
] as const;

export interface RankingRow {
  id: string;
  title: string;
  model: string;
  /** The entry's `source` column. Travels WITH `model`, exactly as it does on
   *  a neighbourhood node and a relatives row: the provider badge is the two
   *  together, and a Suno song's model is `chirp-*` while its source says
   *  'suno'. */
  source: string;
  count: number;
  /** Server-written one-liner for the row ("8 covers, 3 edits", a date, …). */
  detail: string;
}

export interface RankingsResult {
  list: RankingList;
  rows: RankingRow[];
}

export interface NeighbourNode {
  id: string;
  title: string;
  model: string;
  source: string;
  duration_sec: number;
  play_count: number;
  /** False for an id that exists only as a link endpoint — a deleted song. */
  in_library: boolean;
  /** < 0 sources (up), 0 the focus, > 0 derivatives (down). */
  generation: number;
}

export interface NeighbourEdge {
  /** The derived song (`from_id` in the DB). */
  from: string;
  /** Its source (`to_id` in the DB). */
  to: string;
  /** Every relation stored for this pair — duplicates merged into one edge. */
  kinds: string[];
  role: LinkRole;
}

export interface NeighbourGroup {
  id: string;
  parent_id: string;
  direction: 'up' | 'down';
  kind: string;
  count: number;
  sample_ids: string[];
}

export interface HiddenCount {
  up: number;
  down: number;
}

export interface Neighbourhood {
  /** The focus id. The view re-derives the focus node from `nodes` as well. */
  focus: string;
  nodes: NeighbourNode[];
  edges: NeighbourEdge[];
  groups: NeighbourGroup[];
  hidden: Record<string, HiddenCount>;
  truncated: boolean;
  budget: number;
}

export type RelativesDirection = 'up' | 'down';
export type RelativesSort = 'title' | 'plays' | 'recent';

export interface RelativeRow {
  id: string;
  title: string;
  model: string;
  /** The entry's `source` column. Travels WITH `model`: the provider badge
   *  needs both, and a legacy Suno import has an empty model. */
  source: string;
  duration_sec: number;
  play_count: number;
  kinds: string[];
}

export interface RelativesPage {
  total: number;
  rows: RelativeRow[];
}

/** Everything a `relatives` request is made of. One object, so a group box can
 *  hand the panel its query whole. */
export interface RelativesRequest {
  entryId: string;
  direction: RelativesDirection;
  /** A relation kind, or 'all'. */
  kind: string;
  sort: RelativesSort;
  offset: number;
  limit: number;
}

/* ───────────────────────────── URL construction ──────────────────────────── */

/** An entry id is user data and can hold anything; it is always escaped. */
const idPath = (entryId: string): string => `${LINEAGE_SCALE_BASE}/${encodeURIComponent(entryId)}`;

export const summaryUrl = (): string => `${LINEAGE_SCALE_BASE}/summary`;

export const rankingsUrl = (list: RankingList, limit = 50): string => {
  const params = new URLSearchParams({
    list,
    limit: String(clampInt(limit, 1, RANKING_LIMIT_MAX, 50)),
  });
  return `${LINEAGE_SCALE_BASE}/rankings?${params.toString()}`;
};

export const neighbourhoodUrl = (
  entryId: string,
  opts: { up?: number; down?: number; budget?: number } = {},
): string => {
  const params = new URLSearchParams({
    up: String(clampDepth(opts.up, 2)),
    down: String(clampDepth(opts.down, 1)),
    budget: String(clampBudget(opts.budget)),
  });
  return `${idPath(entryId)}/neighbourhood?${params.toString()}`;
};

export const relativesUrl = (req: RelativesRequest): string => {
  const params = new URLSearchParams({
    direction: req.direction,
    kind: req.kind || 'all',
    sort: req.sort,
    offset: String(clampInt(req.offset, 0, Number.MAX_SAFE_INTEGER, 0)),
    limit: String(clampInt(req.limit, 1, RELATIVES_LIMIT_MAX, 100)),
  });
  return `${idPath(req.entryId)}/relatives?${params.toString()}`;
};

/* ──────────────────────────────── requests ───────────────────────────────── */

export const fetchLineageSummary = (): Promise<LineageSummary> =>
  getJson<LineageSummary>(summaryUrl());

/**
 * `/summary`, with ONE failure told apart from all the others.
 *
 * `absent` means the route is not there: a backend built before this module
 * exists, which is the only failure that may send the LEARN tab to the classic
 * whole-library view. Every other failure — a 500, a 503 while the library is
 * still coming up, a dropped connection — leaves the size of the library
 * UNKNOWN, and on a 195,000-song library mounting the classic view then is the
 * crash this module was built to escape. So those throw, and the caller shows
 * an error with a retry instead of guessing.
 *
 * `getJson` cannot serve this: it turns a failure into an `Error` whose message
 * is the FastAPI `detail`, so the status is gone by the time a caller sees it.
 * Hence plain `fetch` here, with the same pairing header and the same body
 * description apiJson applies (`lib/apiJson.ts`, `lib/httpError.ts`).
 */
export type SummaryProbe =
  | { kind: 'ok'; summary: LineageSummary }
  | { kind: 'absent' };

export async function fetchLineageSummaryProbe(): Promise<SummaryProbe> {
  const url = summaryUrl();
  // apiJson's own header rule and its own failure description, imported rather
  // than copied: the header must ride along on exactly the requests `getJson`
  // would send it with, and a failure must read the same `{detail}`/`{error}`
  // body `getJson` reads. Both were duplicated here, and the copies had
  // already drifted -- the probe's reader ignored `error`, so this app's own
  // routes came out of it as a bare `HTTP 500`.
  const res = await fetch(url, { headers: pairingHeaderFor(url) });
  if (res.status === 404) return { kind: 'absent' };
  if (!res.ok) throw new Error(await describeApiError(res));
  return { kind: 'ok', summary: (await res.json()) as LineageSummary };
}

export const fetchRankings = (list: RankingList, limit = 50): Promise<RankingsResult> =>
  getJson<RankingsResult>(rankingsUrl(list, limit));

export const fetchNeighbourhood = (
  entryId: string,
  opts: { up?: number; down?: number; budget?: number } = {},
): Promise<Neighbourhood> => getJson<Neighbourhood>(neighbourhoodUrl(entryId, opts));

export const fetchRelatives = (req: RelativesRequest): Promise<RelativesPage> =>
  getJson<RelativesPage>(relativesUrl(req));
