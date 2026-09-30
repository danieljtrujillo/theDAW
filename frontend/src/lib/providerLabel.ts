/**
 * providerLabel — the pure display model for an entry's PROVIDER: the service
 * the audio came from (Stable Audio, Suno, Udio, Bandcamp, …).
 *
 * There is ONE provider per entry, and `catalog/catalogProviders.ts` owns it:
 * the slug the backend DETECTED in the file's own embedded metadata
 * (`provider` / `providerLabel` / `providerIsAi` / `providerId`) when it sent
 * one, and the historical model/source derivation otherwise. This module turns
 * that one id into what the UI draws and what a screen reader says — the badge
 * text, the accessible name, the search text, the membership test behind the
 * filter — so every surface says the same thing about the same entry.
 *
 * Because the id always resolves, every real entry HAS a display model; only a
 * null/undefined entry has none. Callers no longer choose between a detected
 * badge and a derived one.
 *
 * No React, no store, no I/O.
 */

import {
  entryProviderIsAi,
  entryProviderMeta,
  inferProvider,
  type ProviderEntryFields,
} from '../catalog/catalogProviders';

/**
 * The provider-bearing fields of a `LibraryEntry`: the four wire fields plus
 * the `model` / `source` the derivation falls back to. Re-exported under the
 * name the UI already imports.
 */
export type ProviderFields = ProviderEntryFields;

/** Everything the UI needs to draw and announce one provider. */
export interface ProviderDisplay {
  /** The entry's provider id — the backend's slug, e.g. `suno`, or a derived one. */
  slug: string;
  /** Display name, e.g. `Suno`. */
  label: string;
  /** True for an AI generation service, false for a store/host or an import. */
  isAi: boolean;
  /** The provider's own track id, when the file carried one. */
  providerId: string | null;
  /** The badge's visible text. */
  text: string;
  /** The badge's accessible name, e.g. `Source: Suno (AI)`. */
  accessibleName: string;
}

const trimmed = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * The display model for an entry, or null when there is no entry at all.
 *
 * The label is the backend's when it sent one, the registry's for a provider
 * we know, and a title-cased slug otherwise — so a provider the frontend has
 * never heard of reads sensibly the moment the backend starts detecting it,
 * with no code change here.
 */
export const providerDisplay = (
  entry: ProviderFields | null | undefined,
): ProviderDisplay | null => {
  if (entry == null) return null;
  const slug = inferProvider(entry);
  if (!slug) return null;
  const label = entryProviderMeta(entry).label;
  const isAi = entryProviderIsAi(entry);
  const providerId = trimmed(entry.providerId);
  return {
    slug,
    label,
    isAi,
    providerId: providerId || null,
    text: label,
    accessibleName: `Source: ${label}${isAi ? ' (AI)' : ''}`,
  };
};

/**
 * The provider's contribution to a client-side search haystack: the label and
 * the slug when they differ (so both "Apple Music" and "apple-music" hit, and
 * so does "Suno" on a row whose model says nothing). '' for no entry.
 *
 * ONE function, every haystack: the Catalogue's `catalogSearch` and the
 * library store's own filter both call it, so a query that finds a row in one
 * finds it in the other.
 */
export const providerSearchText = (entry: ProviderFields | null | undefined): string => {
  const info = providerDisplay(entry);
  if (!info) return '';
  return info.label.toLowerCase() === info.slug.toLowerCase()
    ? info.label
    : `${info.label} ${info.slug}`;
};

/**
 * Does this entry belong to the given provider? Case-insensitive; ''/null
 * matches nothing. The exact membership test behind the provider filter, run
 * against the same id the dropdown's options were built from.
 */
export const hasProvider = (
  entry: ProviderFields | null | undefined,
  slug: string | null | undefined,
): boolean => {
  const want = trimmed(slug).toLowerCase();
  if (!want || entry == null) return false;
  return inferProvider(entry).toLowerCase() === want;
};
