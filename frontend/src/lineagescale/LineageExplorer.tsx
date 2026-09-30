import React from 'react';
import { ExploreList } from './ExploreList';
import {
  EXPLORE_KINDS, KIND_ANY, ROLE_WORDS, SORT_WORDS, exploreHint, exploreSorts, exploreTitle,
} from './exploreModel';
import type {
  ExploreDir, ExplorePage, ExploreRole, ExploreSort, ExploreSpec,
} from './exploreModel';
import { relationWords } from '../lib/lineageInsights';

/**
 * LineageExplorer — the panel every number on the LEARN landing page opens.
 *
 * A panel INSIDE the tab, not a modal over the app: you came here to read the
 * library, and a list you have to dismiss to see the numbers again is a list
 * you cannot compare against them.
 *
 * It is presentational on purpose. The query (which list, which page, the
 * search, the sort) lives in the landing page and arrives here as props, so
 * the whole panel can be rendered and asserted without a browser or a server
 * (`LineageExplorer.test.tsx`), and so the back-to-the-numbers button does not
 * need to unwind state this file owns.
 *
 * Accessibility: every native control here — search, kind, role, sort,
 * direction, page — has a stable id/name and its own <label htmlFor>. The
 * buttons are named with `aria-label` instead, because a <label> does not name
 * a non-native control (project CLAUDE.md rule 3).
 */

export interface LineageExplorerProps {
  spec: ExploreSpec;
  page: ExplorePage | null;
  loading: boolean;
  error: string | null;
  q: string;
  sort: ExploreSort;
  dir: ExploreDir;
  onQuery: (q: string) => void;
  onSort: (sort: ExploreSort) => void;
  onDir: (dir: ExploreDir) => void;
  onOffset: (offset: number) => void;
  onSpec: (spec: ExploreSpec) => void;
  onClose: () => void;
  onFocus: (id: string, title: string) => void;
  onCopyId: (id: string) => void;
  onRetry?: () => void;
  /** Prefix for the control ids. One explorer is on screen at a time. */
  idPrefix?: string;
}

const LABEL_CLASS = 'text-[9px] font-mono uppercase tracking-widest text-zinc-500';
const FIELD_CLASS =
  'rounded border border-white/10 bg-black/60 px-2 py-1 text-[10px] font-mono text-zinc-200 focus:border-purple-400/60 focus:outline-none';

export const LineageExplorer: React.FC<LineageExplorerProps> = ({
  spec, page, loading, error, q, sort, dir,
  onQuery, onSort, onDir, onOffset, onSpec, onClose, onFocus, onCopyId, onRetry,
  idPrefix = 'lineage-explorer',
}) => {
  const sorts = exploreSorts(spec);
  const showKind = spec.list === 'kind' || spec.list === 'rankings';
  // A ranking and the family list have no `q` on the wire, so there is no box
  // for one: a search field that filters nothing is worse than no field.
  const showSearch = spec.list !== 'rankings' && spec.list !== 'families';
  const showDir = spec.list !== 'rankings';
  const qId = `${idPrefix}-q`;
  const kindId = `${idPrefix}-kind`;
  const roleId = `${idPrefix}-role`;
  const sortId = `${idPrefix}-sort`;
  const dirId = `${idPrefix}-dir`;
  const roles: ExploreRole[] =
    spec.list === 'rankings' ? ['parent', 'child'] : ['any', 'parent', 'child'];
  const targeted = spec.list === 'kind' || spec.list === 'rankings';
  const role: ExploreRole = targeted ? spec.role : 'any';
  const kind = targeted ? spec.kind : KIND_ANY;

  const retarget = (next: { kind?: string; role?: ExploreRole }): void => {
    if (spec.list === 'kind') {
      onSpec({ list: 'kind', kind: next.kind ?? spec.kind, role: next.role ?? spec.role });
    } else if (spec.list === 'rankings') {
      const nextRole = (next.role ?? spec.role) as 'parent' | 'child';
      onSpec({
        list: 'rankings',
        kind: next.kind ?? spec.kind,
        role: nextRole === 'child' ? 'child' : 'parent',
      });
    }
  };

  return (
    <section
      aria-label={exploreTitle(spec)}
      className="flex min-h-0 flex-col gap-2 rounded border border-purple-500/20 bg-black/50 p-3"
    >
      <header className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 grow">
          <h3 className="text-[11px] font-mono uppercase tracking-widest text-zinc-200">
            {exploreTitle(spec)}
          </h3>
          <p className="mt-0.5 text-[9px] font-mono text-zinc-500">{exploreHint(spec)}</p>
        </div>
        <button
          type="button"
          aria-label="Close this list"
          onClick={onClose}
          className="shrink-0 rounded border border-white/10 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-300 hover:border-white/25 hover:text-white"
        >
          Back to the numbers
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {showSearch && (
          <>
            <label htmlFor={qId} className={LABEL_CLASS}>
              Search
            </label>
            <input
              id={qId}
              name={qId}
              type="search"
              value={q}
              placeholder="title…"
              onChange={(e) => onQuery(e.target.value)}
              className={`w-48 ${FIELD_CLASS} placeholder-zinc-600`}
            />
          </>
        )}

        {showKind && (
          <>
            <label htmlFor={kindId} className={LABEL_CLASS}>
              Kind
            </label>
            <select
              id={kindId}
              name={kindId}
              value={kind}
              onChange={(e) => retarget({ kind: e.target.value })}
              className={FIELD_CLASS}
            >
              {spec.list === 'rankings' && <option value={KIND_ANY}>any relationship</option>}
              {EXPLORE_KINDS.map((value) => (
                <option key={value} value={value}>
                  {relationWords(value)}
                </option>
              ))}
            </select>
            <label htmlFor={roleId} className={LABEL_CLASS}>
              Role
            </label>
            <select
              id={roleId}
              name={roleId}
              value={role}
              onChange={(e) => retarget({ role: e.target.value as ExploreRole })}
              className={FIELD_CLASS}
            >
              {roles.map((value) => (
                <option key={value} value={value}>
                  {ROLE_WORDS[value]}
                </option>
              ))}
            </select>
          </>
        )}

        <label htmlFor={sortId} className={LABEL_CLASS}>
          Sort
        </label>
        <select
          id={sortId}
          name={sortId}
          value={sort}
          onChange={(e) => onSort(e.target.value as ExploreSort)}
          className={FIELD_CLASS}
        >
          {sorts.map((value) => (
            <option key={value} value={value}>
              {SORT_WORDS[value]}
            </option>
          ))}
        </select>

        {showDir && (
          <>
            <label htmlFor={dirId} className={LABEL_CLASS}>
              Order
            </label>
            <select
              id={dirId}
              name={dirId}
              value={dir}
              onChange={(e) => onDir(e.target.value as ExploreDir)}
              className={FIELD_CLASS}
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
          </>
        )}
      </div>

      <ExploreList
        spec={spec}
        page={page}
        loading={loading}
        error={error}
        idPrefix={idPrefix}
        onOffset={onOffset}
        onFocus={onFocus}
        onCopyId={onCopyId}
        onOpenFamily={(id, title) => onSpec({ list: 'family', id, title })}
        onRetry={onRetry}
      />
    </section>
  );
};

export default LineageExplorer;
