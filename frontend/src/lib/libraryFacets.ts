/**
 * Library facets: the distinct values of a field across the WHOLE result set,
 * with a count each.
 *
 * A 200,000-entry library never has more than a few hundred rows in memory, so
 * a filter dropdown built by walking the loaded rows offers whatever happened
 * to be on screen — the model you are looking for is missing until you scroll
 * to it. The backend answers `GET /api/library/entries/facets` instead; this
 * module is the pure part: what a cached answer is keyed by, and how an answer
 * (or its absence) becomes the options a <select> renders.
 *
 * Pure — no React, no store, no fetch — so the store, the filter bar and the
 * test all agree on one key and one option list.
 */

/** The fields the backend will group by. */
export type LibraryFacetField = 'model' | 'provider' | 'source' | 'kind';

/** One distinct value of a facet field. `value` is null for the empty bucket. */
export interface LibraryFacetValue {
  readonly value: string | null;
  readonly count: number;
}

/** A facet answer: the values per requested field, already sorted by the server. */
export type LibraryFacets = Partial<Record<LibraryFacetField, readonly LibraryFacetValue[]>>;

/**
 * The parts of a library query that can change a count. The sort order cannot,
 * so it is deliberately absent: re-sorting the list must not refetch facets.
 * `LibraryQuery` is structurally assignable to this.
 */
export interface LibraryFacetQuery {
  /** Free-text search; '' means no text filter. */
  readonly q: string;
  /** 'audio' (the default), 'media', 'video', 'image' or 'all'. */
  readonly kind: string;
  /** true = favorites only; false/null = no favorite filter. */
  readonly favorite: boolean | null;
  /** 'generate' | 'studio' | 'import', or null for any source. */
  readonly source: string | null;
  /**
   * A provider id ('suno', 'stable-audio', …), or null for any provider.
   *
   * The request carries it (`queryParams` puts every filter on the URL), so it
   * narrows the counts the server returns — which means it also has to be part
   * of the cache key below, or a second provider would be answered from the
   * first one's cached counts.
   */
  readonly provider: string | null;
}

/** An option a <select> can render: a real value, its label, its count. */
export interface LibraryFacetOption {
  /** The option's `value` attribute. Never empty — '' is reserved for "all". */
  readonly value: string;
  readonly label: string;
  /** The server's count, or null when no facet answer covers this value. */
  readonly count: number | null;
}

/**
 * The cache key for one facet answer.
 *
 * Two requests share an answer exactly when they ask for the same fields over
 * the same filters at the same library revision. `revision` must be a
 * non-negative integer (the DB's `library_revision`); anything else is a bug in
 * the caller rather than a cache miss, so it throws.
 */
export function facetCacheKey(
  fields: readonly LibraryFacetField[],
  query: LibraryFacetQuery,
  revision: number,
): string {
  if (!Number.isInteger(revision) || revision < 0) {
    throw new RangeError(`facetCacheKey: revision must be a non-negative integer, got ${revision}`);
  }
  // Sorted, so two callers asking for the same fields in a different order
  // share one answer. The separators cannot appear in a field name.
  const wanted = [...fields].sort().join(',');
  return [
    wanted,
    query.q.trim(),
    query.kind,
    query.favorite === true ? 'fav' : '',
    query.source ?? '',
    query.provider ?? '',
    String(revision),
  ].join('\u0000');
}

/**
 * The options a dropdown shows for one field.
 *
 * The server's values come first, in the order it sent them (count desc), each
 * with its count. Values the caller knows about but the server did not mention
 * — the provider list's fixed order, the models on the rows in hand — follow
 * with no count, so switching to an old backend that has no facets endpoint
 * degrades to exactly the old list rather than to an empty one.
 *
 * The null bucket is dropped: an <option> with an empty value already means
 * "no filter", and there is no query parameter that says "the ones with none".
 */
export function facetOptions(
  values: readonly LibraryFacetValue[] | undefined,
  fallback: readonly string[],
  label: (value: string) => string = (v) => v,
): LibraryFacetOption[] {
  const options: LibraryFacetOption[] = [];
  const seen = new Set<string>();
  for (const v of values ?? []) {
    if (v.value == null || v.value === '') continue;
    if (seen.has(v.value)) continue;
    seen.add(v.value);
    options.push({ value: v.value, label: label(v.value), count: v.count });
  }
  for (const v of fallback) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    options.push({ value: v, label: label(v), count: null });
  }
  return options;
}

/** `Suno (1,234)`, or just `Suno` when there is no count to show. */
export function facetOptionLabel(option: LibraryFacetOption): string {
  return option.count == null ? option.label : `${option.label} (${option.count.toLocaleString()})`;
}
