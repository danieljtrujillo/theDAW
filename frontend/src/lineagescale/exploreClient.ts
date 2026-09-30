/**
 * The client for `/api/lineage-scale/explore` — the routes that turn every
 * number on the LEARN landing page into a list you can open.
 *
 * URL building plus `getJson`, exactly like `lineageScaleClient.ts`: the
 * pairing header rides along with every request and a FastAPI `{detail}`
 * comes back as the thrown message. The clamps are applied BEFORE the request
 * so a pager that has run past the end cannot turn into a 422.
 *
 * One request per page. Nothing here loads the library, and no route it calls
 * reads a `*_json` column.
 */
import { getJson } from '../lib/apiJson';
import { LINEAGE_SCALE_BASE, clampInt } from './lineageScaleClient';
import { EXPLORE_PAGE, KIND_ANY } from './exploreModel';
import type { ExplorePage, ExploreSpec } from './exploreModel';

export const EXPLORE_BASE = `${LINEAGE_SCALE_BASE}/explore`;

/** Rows one page may hold. The route's own ceiling. */
export const EXPLORE_LIMIT_MAX = 500;

export interface ExploreQuery {
  spec: ExploreSpec;
  q?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  offset?: number;
  limit?: number;
}

/** The lists whose route filters on a title substring. */
const SEARCHABLE: ReadonlySet<string> = new Set(['songs', 'kind', 'family']);

/** An entry id is user data and can hold anything; it is always escaped. */
const idPath = (id: string): string => encodeURIComponent(id);

const paging = (query: ExploreQuery): [string, string][] => [
  ['offset', String(clampInt(query.offset ?? 0, 0, Number.MAX_SAFE_INTEGER, 0))],
  ['limit', String(clampInt(query.limit ?? EXPLORE_PAGE, 1, EXPLORE_LIMIT_MAX, EXPLORE_PAGE))],
];

/** The URL for one page of one list. */
export function exploreUrl(query: ExploreQuery): string {
  const { spec } = query;
  const params = new URLSearchParams(paging(query));
  // `q` goes only where a route reads it. `/rankings` and `/families` have no
  // `q` parameter: sending one is a query string that promises a filter the
  // answer does not have.
  if (SEARCHABLE.has(spec.list) && query.q && query.q.trim()) {
    params.set('q', query.q.trim());
  }
  if (query.sort) params.set('sort', query.sort);
  if (query.dir) params.set('dir', query.dir);
  switch (spec.list) {
    case 'songs':
      params.set('set', spec.set);
      return `${EXPLORE_BASE}/songs?${params.toString()}`;
    case 'kind':
      params.set('role', spec.role);
      return `${EXPLORE_BASE}/kinds/${idPath(spec.kind)}?${params.toString()}`;
    case 'rankings':
      params.set('kind', spec.kind || KIND_ANY);
      params.set('role', spec.role);
      // `dir` is not a parameter of the ranking route: a ranking is read from
      // the top. Sending it would be a 400.
      params.delete('dir');
      params.set('sort', 'count');
      return `${EXPLORE_BASE}/rankings?${params.toString()}`;
    case 'families':
      params.set('sort', 'size');
      return `${EXPLORE_BASE}/families?${params.toString()}`;
    case 'family':
      return `${EXPLORE_BASE}/families/${idPath(spec.id)}/members?${params.toString()}`;
    default:
      return `${EXPLORE_BASE}/songs?${params.toString()}`;
  }
}

export const fetchExplorePage = (query: ExploreQuery): Promise<ExplorePage> =>
  getJson<ExplorePage>(exploreUrl(query));
