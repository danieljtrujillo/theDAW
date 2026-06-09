/**
 * catalogueUiStore — LOCAL, view-only UI state for the Catalogue tab.
 *
 * This holds ONLY the search/filter/sort/view-mode state that belongs to the
 * Catalogue view. It is NOT a copy of the library data — `entries`, favorites,
 * ratings, selection, etc. all live in the existing `useLibraryStore` (the
 * single source of truth). Keeping this tiny store in the catalog folder lets
 * the filter bar, list, and inspector share search state without prop-drilling
 * and without duplicating the library.
 */

import { create } from 'zustand';
import {
  DEFAULT_SEARCH_STATE,
  type CatalogueSearchState,
} from './catalogSearch';

export type CatalogueViewMode = 'list' | 'grid';

interface CatalogueUiState extends CatalogueSearchState {
  viewMode: CatalogueViewMode;
  /** Shallow-merge a partial search-state patch. */
  patchSearch: (patch: Partial<CatalogueSearchState>) => void;
  setViewMode: (m: CatalogueViewMode) => void;
  resetSearch: () => void;
}

export const useCatalogueUiStore = create<CatalogueUiState>()((set) => ({
  ...DEFAULT_SEARCH_STATE,
  viewMode: 'list',
  patchSearch: (patch) => set(patch),
  setViewMode: (viewMode) => set({ viewMode }),
  resetSearch: () => set({ ...DEFAULT_SEARCH_STATE }),
}));

/** Selector helper: pull the pure `CatalogueSearchState` slice out of the
 *  store (so it can be handed straight to `filterAndSort`). */
export const selectSearchState = (s: CatalogueUiState): CatalogueSearchState => ({
  query: s.query,
  searchTarget: s.searchTarget,
  mode: s.mode,
  onlyFavorites: s.onlyFavorites,
  sourceFilter: s.sourceFilter,
  providerFilter: s.providerFilter,
  modelFilter: s.modelFilter,
  ratingFilter: s.ratingFilter,
  durationMin: s.durationMin,
  durationMax: s.durationMax,
  sortBy: s.sortBy,
});
