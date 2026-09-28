/**
 * AssetInspectorModal — the centered pop-out that shows EVERYTHING the app
 * knows about one library asset.
 *
 * Opened by double-clicking a library row. It is keyed by the asset's stable
 * entry id, never by its title or its row index: filtering, sorting, renaming
 * or deleting other rows while it is open cannot make it show a different
 * asset. If the asset it is showing leaves the library, it says so and stays
 * on that asset rather than sliding to a neighbour.
 *
 * The header renders immediately from the record the library already holds
 * (artwork, title, id, kind, duration, format / sample rate / channels, and an
 * audition key that drives the same global preview player every other surface
 * uses). Each tab loads its own data the first time it is opened, so opening
 * the dialog costs one render and no requests.
 *
 * Every key pressed inside stops at the dialog, so EDIT's window-level Escape
 * and Delete handlers never act on the timeline behind it. Focus starts on the
 * close key, Tab wraps inside, and closing returns focus to whatever opened it.
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Info, Loader2, Network, Search, X } from 'lucide-react';
import { CoverArt } from '../../catalog/CoverArt';
import { SurfacePlayKey } from '../ui/SurfacePlayKey';
import { useLibraryStore } from '../../state/libraryStore';
import { usePlayerStore } from '../../state/playerStore';
import { useSetlistStore } from '../../state/setlistStore';
import { logError } from '../../state/logStore';
import { deriveLyrics, deriveStyle } from '../../catalog/catalogSearch';
import { fetchBlobWithRetry } from '../../lib/fetchRetry';
import { edgeColor, relationWords, relativesOf, type LineageNode } from '../../lib/lineageInsights';
import { LineageFamilyNotice, RelativeList, useLineageFamily } from './LineageFamilyNotice';
import { FLYOUT_CARD } from '../audio/midiDockKit';
import {
  ASSET_INSPECTOR_TAB_STORAGE_KEY,
  INSPECTOR_TABS,
  UNKNOWN,
  filterPrettyJson,
  formatBytes,
  headerFacts,
  overviewGroups,
  sanitizeTab,
  setlistsReferencing,
  stemParentId,
  stemsOfParent,
  tabAfterKey,
  toRedactedJson,
  type InspectorStem,
  type InspectorTab,
} from './assetInspectorModel';

export type { InspectorTab } from './assetInspectorModel';

interface Props {
  /** The asset to inspect; null closes the dialog. Stable entry id only. */
  entryId: string | null;
  onClose: () => void;
  /** Open on a specific tab instead of the remembered one. */
  initialTab?: InspectorTab;
}

/** Everything inside the dialog that can take focus, for the Tab wrap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [role="tab"], [tabindex]:not([tabindex="-1"])';

const KEY =
  'flex items-center gap-1.5 rounded-xs border border-white/10 px-2 py-1 text-xs font-bold text-zinc-300 hover:border-purple-400/50 hover:text-zinc-100 disabled:opacity-40';

const SECTION = 'flex flex-col gap-1.5 rounded border border-white/5 bg-white/3 p-2';

const readStoredTab = (): unknown => {
  try {
    return window.localStorage.getItem(ASSET_INSPECTOR_TAB_STORAGE_KEY);
  } catch {
    return null;
  }
};

const dispatchEntryEvent = (name: 'thedaw:open-lineage' | 'thedaw:reveal-library-entry', entryId: string): void => {
  window.dispatchEvent(new CustomEvent(name, { detail: { entryId } }));
};

/** A copy key that confirms in place for a moment. */
const CopyKey: React.FC<{ label: string; title: string; text: () => string }> = ({ label, title, text }) => {
  const [done, setDone] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  return (
    <button
      type="button"
      className={KEY}
      title={title}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text())
          .then(() => {
            setDone(true);
            if (timer.current !== null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setDone(false), 1200);
          })
          .catch(() => undefined);
      }}
    >
      {done ? <Check className="size-3 text-emerald-300" aria-hidden="true" /> : <Copy className="size-3" aria-hidden="true" />}
      {label}
    </button>
  );
};

const Facts: React.FC<{ rows: readonly { label: string; value: string; multiline?: boolean }[] }> = ({ rows }) => (
  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs font-bold">
    {rows.map((r) => (
      <React.Fragment key={r.label}>
        <dt className="text-zinc-500">{r.label}</dt>
        <dd className={`min-w-0 wrap-break-word ${r.value === UNKNOWN ? 'text-zinc-600 italic' : 'text-zinc-200'} ${r.multiline ? 'whitespace-pre-wrap' : ''}`}>
          {r.value}
        </dd>
      </React.Fragment>
    ))}
  </dl>
);

const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="py-6 text-center text-xs font-bold text-zinc-500">{children}</p>
);

export const AssetInspectorModal: React.FC<Props> = ({ entryId, onClose, initialTab }) => {
  const uid = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const tabRefs = useRef<Partial<Record<InspectorTab, HTMLButtonElement | null>>>({});

  const entry = useLibraryStore((s) => (entryId ? s.entries.find((e) => e.id === entryId) : undefined));
  const libraryLoaded = useLibraryStore((s) => s.loaded);
  const fetchAudioBlob = useLibraryStore((s) => s.fetchAudioBlob);
  const playerIsPlaying = usePlayerStore((s) => s.isPlaying);
  const playerEntryId = usePlayerStore((s) => s.currentEntryId);
  const setlists = useSetlistStore((s) => s.setlists);

  const [tab, setTab] = useState<InspectorTab>(() =>
    initialTab !== undefined ? sanitizeTab(initialTab) : sanitizeTab(readStoredTab()),
  );
  // Per-tab, per-entry loads. `null` means "not fetched yet for this entry".
  const [stemRows, setStemRows] = useState<Array<Record<string, unknown>> | null>(null);
  const [bundledSetlists, setBundledSetlists] = useState<Array<{ id: string; name: string; entries: Array<{ entryId: string | null }> }> | null>(null);
  const [raw, setRaw] = useState<unknown>(null);
  const [rawFailed, setRawFailed] = useState(false);
  const [rawQuery, setRawQuery] = useState('');
  const [busyStemId, setBusyStemId] = useState<string | null>(null);
  const [playingStemId, setPlayingStemId] = useState<string | null>(null);

  const ids = {
    heading: `${uid}-heading`,
    search: `${uid}-raw-search`,
    tab: (t: InspectorTab) => `${uid}-tab-${t}`,
    panel: (t: InspectorTab) => `${uid}-panel-${t}`,
  };

  /* Remember the tab across openings — only while the dialog is actually
     open, so a closed, always-mounted instance never writes storage. */
  useEffect(() => {
    if (!entryId) return;
    try {
      window.localStorage.setItem(ASSET_INSPECTOR_TAB_STORAGE_KEY, tab);
    } catch {
      /* private mode / storage full: the tab simply is not remembered. */
    }
  }, [tab, entryId]);

  /* A new asset drops everything the previous one loaded. */
  useEffect(() => {
    setStemRows(null);
    setBundledSetlists(null);
    setRaw(null);
    setRawFailed(false);
    setRawQuery('');
    setPlayingStemId(null);
  }, [entryId]);

  /* Focus starts on the close key and returns to the opener on close. */
  useEffect(() => {
    if (!entryId) return undefined;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener && opener.isConnected) opener.focus();
    };
  }, [entryId]);

  /* Stems and the "is this entry itself a stem?" answer both come from here. */
  const needsStems = tab === 'stems';
  const needsLineage = tab === 'stems' || tab === 'lineage';

  useEffect(() => {
    if (!entryId || !needsStems || stemRows !== null) return undefined;
    let cancelled = false;
    void fetch('/api/library/_all/stems')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { stems?: Array<Record<string, unknown>> } | null) => {
        if (!cancelled) setStemRows(j?.stems ?? []);
      })
      .catch((e) => {
        if (cancelled) return;
        setStemRows([]);
        logError('library', `Inspector could not read stems: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [entryId, needsStems, stemRows]);

  // The capped family (read when a tab needs it, kept for this asset), and
  // the whole one when the user asks for it.
  const lineageState = useLineageFamily(entryId, 4, needsLineage);
  const lineage = lineageState.family;

  useEffect(() => {
    if (!entryId || tab !== 'usedIn' || bundledSetlists !== null) return undefined;
    let cancelled = false;
    void fetch('/api/library/setlists')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { setlists?: Array<{ id: string; name: string; entries: Array<{ entryId: string | null }> }> } | null) => {
        if (!cancelled) setBundledSetlists(j?.setlists ?? []);
      })
      .catch(() => {
        if (!cancelled) setBundledSetlists([]);
      });
    return () => {
      cancelled = true;
    };
  }, [entryId, tab, bundledSetlists]);

  /* Raw metadata is the one genuinely heavy read, so it waits for its tab. */
  useEffect(() => {
    if (!entryId || tab !== 'raw' || raw !== null || rawFailed) return undefined;
    let cancelled = false;
    void fetch(`/api/library/entries/${encodeURIComponent(entryId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: unknown) => {
        if (cancelled) return;
        // A null/absent body is "could not read", not "read an empty record":
        // leaving `raw` null would re-fire this effect on every render.
        if (j === null || j === undefined) setRawFailed(true);
        else setRaw(j);
      })
      .catch((e) => {
        if (cancelled) return;
        setRawFailed(true);
        logError('library', `Inspector could not read raw metadata: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [entryId, tab, raw, rawFailed]);

  const selectTab = useCallback((next: InspectorTab) => {
    setTab(next);
    // Automatic activation: the arrow keys move focus with the selection.
    window.requestAnimationFrame(() => tabRefs.current[next]?.focus());
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Nothing pressed in here reaches the timeline's Escape / Delete handlers.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const box = dialogRef.current;
    if (!box) return;
    // getClientRects() rather than offsetParent: the dialog sits inside a
    // fixed-position scrim, where offsetParent is unreliable. The hidden tab
    // panels and anything inside them drop out here.
    const focusables = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.getClientRects().length > 0,
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onTabListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const next = tabAfterKey(tab, e.key);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    selectTab(next);
  };

  const auditioning = !!entry && playerEntryId === entry.id && playerIsPlaying;
  const toggleAudition = async () => {
    if (!entry) return;
    const player = usePlayerStore.getState();
    if (player.currentEntryId === entry.id) {
      if (player.isPlaying) player.pause();
      else player.play();
      return;
    }
    try {
      const blob = await fetchAudioBlob(entry);
      await player.load(blob, { label: entry.title, entryId: entry.id });
      player.play();
    } catch (e) {
      logError('library', `Could not audition ${entry.title}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const playStem = async (stem: InspectorStem) => {
    const player = usePlayerStore.getState();
    if (playingStemId === stem.id && player.isPlaying && player.currentEntryId === null) {
      player.pause();
      setPlayingStemId(null);
      return;
    }
    setBusyStemId(stem.id);
    try {
      const blob = await fetchBlobWithRetry(`/api/library/stems/${encodeURIComponent(stem.id)}/audio`, { label: stem.name });
      await player.load(blob, { label: stem.name });
      player.play();
      setPlayingStemId(stem.id);
    } catch (e) {
      logError('library', `Could not play ${stem.name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyStemId(null);
    }
  };

  const revealInLibrary = (id: string) => {
    dispatchEntryEvent('thedaw:reveal-library-entry', id);
    onClose();
  };

  const header = useMemo(() => (entry ? headerFacts(entry) : []), [entry]);
  const overview = useMemo(
    () => (entry ? overviewGroups(entry, { style: deriveStyle(entry), lyrics: deriveLyrics(entry) }) : []),
    [entry],
  );
  const stems = useMemo(
    () => (entry && stemRows ? stemsOfParent(stemRows, entry.id) : null),
    [entry, stemRows],
  );
  const parentStem = useMemo(
    () => (entry && lineage ? stemParentId(lineage.edges, entry.id) : null),
    [entry, lineage],
  );
  const family = useMemo(() => {
    if (!entry || !lineage) return null;
    const byId: Record<string, LineageNode> = {};
    for (const n of lineage.nodes) byId[n.id] = n;
    return { read: lineage, byId, ...relativesOf(entry.id, lineage.edges) };
  }, [entry, lineage]);
  const usedIn = useMemo(() => {
    if (!entry) return [];
    const merged = new Map<string, { id: string; name: string; entries: Array<{ entryId: string | null }> }>();
    for (const set of Object.values(setlists)) merged.set(set.id, set);
    for (const set of bundledSetlists ?? []) if (!merged.has(set.id)) merged.set(set.id, set);
    return setlistsReferencing([...merged.values()], entry.id);
  }, [entry, setlists, bundledSetlists]);
  const rawJson = useMemo(() => (raw === null ? '' : toRedactedJson(raw)), [raw]);
  const rawView = useMemo(() => filterPrettyJson(rawJson, rawQuery), [rawJson, rawQuery]);

  if (!entryId) return null;
  if (typeof document === 'undefined') return null;

  const title = entry?.title ?? 'This asset';
  const gone = libraryLoaded && !entry;

  const body = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div aria-hidden="true" className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.heading}
        onKeyDown={onKeyDown}
        className={`${FLYOUT_CARD} relative flex w-[min(960px,94vw)] h-[min(720px,88vh)] max-w-full flex-col`}
      >
        {/* ---------------------------------------------------- header */}
        <div className="flex shrink-0 items-start gap-3 border-b border-white/10 p-3">
          <CoverArt
            coverUrl={entry?.coverUrl}
            title={title}
            className="size-16 shrink-0 rounded-xs"
            iconClassName="size-6"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 id={ids.heading} className="font-display text-sm font-bold wrap-break-word text-zinc-100">
              {title}
            </h2>
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 truncate font-mono text-xs text-zinc-500" title={entryId}>
                {entryId}
              </span>
              <CopyKey label="ID" title="Copy this asset's id" text={() => entryId} />
            </div>
            {entry && (
              <dl className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs font-bold">
                {header.map((f) => (
                  <React.Fragment key={f.label}>
                    <dt className="text-zinc-500">{f.label}</dt>
                    <dd className={f.value === UNKNOWN ? 'text-zinc-600 italic' : 'text-zinc-200'}>{f.value}</dd>
                  </React.Fragment>
                ))}
              </dl>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {entry && (
              <SurfacePlayKey
                size="bar"
                playing={auditioning}
                onToggle={() => void toggleAudition()}
                what={`“${entry.title}”`}
              />
            )}
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close the asset inspector"
              title="Close (Esc)"
              className="flex size-8 items-center justify-center rounded-xs text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
        </div>

        {/* ------------------------------------------------------ tabs */}
        <div
          role="tablist"
          aria-label="Asset details"
          onKeyDown={onTabListKeyDown}
          className="flex shrink-0 items-center gap-1 border-b border-white/10 px-3 py-1.5"
        >
          {INSPECTOR_TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={ids.tab(t.id)}
              aria-selected={tab === t.id}
              aria-controls={ids.panel(t.id)}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => selectTab(t.id)}
              className={`rounded-xs px-2 py-1 text-xs font-bold ${
                tab === t.id
                  ? 'bg-white/5 text-purple-200 shadow-[inset_0_-2px_0_rgb(var(--et-accent))]'
                  : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ----------------------------------------------------- panel */}
        {/* Only the selected tab's panel has content, but every tab needs a
            real element for its aria-controls to resolve, so the rest render
            as empty hidden panels. */}
        {INSPECTOR_TABS.filter((t) => t.id !== tab).map((t) => (
          <div key={t.id} role="tabpanel" id={ids.panel(t.id)} aria-labelledby={ids.tab(t.id)} hidden />
        ))}
        <div
          role="tabpanel"
          id={ids.panel(tab)}
          aria-labelledby={ids.tab(tab)}
          tabIndex={0}
          className="min-h-0 flex-1 overflow-y-auto p-3"
        >
          {gone ? (
            <Empty>This asset is no longer in the library.</Empty>
          ) : !entry ? (
            <Empty>Loading the library…</Empty>
          ) : tab === 'overview' ? (
            <div className="flex flex-col gap-2">
              {overview.map((g) => (
                <section key={g.title} className={SECTION}>
                  <h3 className="font-display text-xs font-bold uppercase text-purple-300">{g.title}</h3>
                  <Facts rows={g.fields} />
                </section>
              ))}
              {entry.chimeraSources && entry.chimeraSources.length > 0 && (
                <section className={SECTION}>
                  <h3 className="font-display text-xs font-bold uppercase text-purple-300">
                    Chimera sources ({entry.chimeraSources.length})
                  </h3>
                  <ol className="flex flex-col gap-0.5">
                    {entry.chimeraSources.map((label, i) => (
                      <li key={`${label}-${i}`} className="truncate text-xs font-bold text-zinc-300" title={label}>
                        <span className="tabular-nums text-purple-400/70">{String(i + 1).padStart(2, '0')}</span> {label}
                      </li>
                    ))}
                  </ol>
                </section>
              )}
            </div>
          ) : tab === 'stems' ? (
            <div className="flex flex-col gap-2">
              {parentStem && (
                <section className={SECTION}>
                  <h3 className="font-display text-xs font-bold uppercase text-purple-300">This asset is a stem</h3>
                  <p className="text-xs font-bold text-zinc-400">
                    It was separated out of{' '}
                    <button
                      type="button"
                      className="text-zinc-200 underline decoration-white/20 underline-offset-2 hover:text-purple-200"
                      onClick={() => revealInLibrary(parentStem)}
                      title="Select the parent track in the library"
                    >
                      {family?.byId[parentStem]?.title || parentStem}
                    </button>
                    .
                  </p>
                </section>
              )}
              {stems === null ? (
                <Empty>
                  <Loader2 className="mr-1 inline size-3.5 animate-spin" aria-hidden="true" /> Reading stems…
                </Empty>
              ) : stems.length === 0 ? (
                <Empty>
                  No stems for this asset. Right-click it in the library and pick Separate stems.
                </Empty>
              ) : (
                <ul className="flex flex-col gap-1">
                  {stems.map((s) => (
                    <li key={s.id} className="flex items-center gap-2 rounded border border-white/5 bg-white/3 p-1.5">
                      <SurfacePlayKey
                        playing={playingStemId === s.id && playerIsPlaying && playerEntryId === null}
                        busy={busyStemId === s.id}
                        onToggle={() => void playStem(s)}
                        what={`the ${s.name} stem`}
                      />
                      <span className="min-w-0 flex-1 truncate text-xs font-bold text-zinc-200">{s.name}</span>
                      <span className="shrink-0 text-xs font-bold text-zinc-500">{s.model ?? UNKNOWN}</span>
                      <span className="shrink-0 tabular-nums text-xs font-bold text-zinc-500">{formatBytes(s.sizeBytes)}</span>
                      <button
                        type="button"
                        className={KEY}
                        onClick={() => revealInLibrary(entry.id)}
                        aria-label={`Show ${entry.title} in the library to reach its ${s.name} stem`}
                        title="Select this track in the library; its stems are listed there under the Stems sub-tab"
                      >
                        Reveal in library
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : tab === 'lineage' ? (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className={`${KEY} self-start`}
                onClick={() => {
                  dispatchEntryEvent('thedaw:open-lineage', entry.id);
                  onClose();
                }}
                title="Open the lineage graph rooted at this asset"
              >
                <Network className="size-3.5" aria-hidden="true" /> Open lineage graph
              </button>
              {lineage && (
                <LineageFamilyNotice
                  family={lineage}
                  busy={lineageState.wholeBusy}
                  error={lineageState.wholeError}
                  onLoadWhole={lineageState.loadWhole}
                />
              )}
              {!family ? (
                lineageState.error ? (
                  <Empty>Could not read the lineage: {lineageState.error}</Empty>
                ) : (
                  <Empty>
                    <Loader2 className="mr-1 inline size-3.5 animate-spin" aria-hidden="true" /> Reading lineage…
                  </Empty>
                )
              ) : family.incoming.length === 0 && family.outgoing.length === 0 ? (
                <Empty>No relatives: nothing made this asset and nothing was made from it.</Empty>
              ) : (
                <section className={SECTION}>
                  <h3 className="font-display text-xs font-bold uppercase text-purple-300">
                    Family
                    <span className="ml-2 font-sans text-xs font-bold normal-case text-zinc-500">
                      {family.ancestors.size} before · {family.descendants.size} after
                    </span>
                  </h3>
                  {family.incoming.length > 0 && (
                    <>
                      <span className="text-xs font-bold text-zinc-500">Came from ({family.incoming.length})</span>
                      <RelativeList
                        items={family.incoming}
                        family={family.read}
                        className="flex flex-col gap-0.5"
                        render={(e, i) => (
                          <RelativeRow
                            key={`in-${e.from_id}-${e.kind}-${i}`}
                            kind={e.kind}
                            id={e.from_id}
                            title={family.byId[e.from_id]?.title}
                            onReveal={revealInLibrary}
                          />
                        )}
                      />
                    </>
                  )}
                  {family.outgoing.length > 0 && (
                    <>
                      <span className="text-xs font-bold text-zinc-500">Led to ({family.outgoing.length})</span>
                      <RelativeList
                        items={family.outgoing}
                        family={family.read}
                        className="flex flex-col gap-0.5"
                        render={(e, i) => (
                          <RelativeRow
                            key={`out-${e.to_id}-${e.kind}-${i}`}
                            kind={e.kind}
                            id={e.to_id}
                            title={family.byId[e.to_id]?.title}
                            onReveal={revealInLibrary}
                          />
                        )}
                      />
                    </>
                  )}
                </section>
              )}
            </div>
          ) : tab === 'usedIn' ? (
            <div className="flex flex-col gap-2">
              {bundledSetlists === null ? (
                <Empty>
                  <Loader2 className="mr-1 inline size-3.5 animate-spin" aria-hidden="true" /> Reading setlists…
                </Empty>
              ) : usedIn.length === 0 ? (
                <Empty>No setlist uses this asset.</Empty>
              ) : (
                <section className={SECTION}>
                  <h3 className="font-display text-xs font-bold uppercase text-purple-300">Setlists ({usedIn.length})</h3>
                  <ul className="flex flex-col gap-0.5">
                    {usedIn.map((s) => (
                      <li key={s.id} className="flex items-baseline gap-2 text-xs font-bold">
                        <span className="min-w-0 flex-1 truncate text-zinc-200">{s.name}</span>
                        <span className="shrink-0 tabular-nums text-zinc-500">
                          {s.positions.length === 1 ? `slot ${s.positions[0]}` : `slots ${s.positions.join(', ')}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <p className="flex items-start gap-1.5 text-xs font-bold text-zinc-500">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                Projects and renders that use this asset will appear here once render lineage tracking ships.
              </p>
            </div>
          ) : (
            <div className="flex h-full flex-col gap-2">
              <div className="flex shrink-0 items-center gap-2">
                <label htmlFor={ids.search} className="sr-only">
                  Search this asset&apos;s raw metadata
                </label>
                <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-xs border border-white/10 px-2">
                  <Search className="size-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
                  <input
                    id={ids.search}
                    name="asset-inspector-raw-search"
                    type="search"
                    value={rawQuery}
                    onChange={(e) => setRawQuery(e.target.value)}
                    placeholder="Search the metadata"
                    disabled={raw === null}
                    className="min-w-0 flex-1 bg-transparent py-1 text-xs font-bold text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
                  />
                </div>
                <CopyKey label="Copy JSON" title="Copy the metadata shown here" text={() => rawView.text} />
              </div>
              {rawFailed ? (
                <Empty>This asset&apos;s raw metadata could not be read.</Empty>
              ) : raw === null ? (
                <Empty>
                  <Loader2 className="mr-1 inline size-3.5 animate-spin" aria-hidden="true" /> Reading metadata…
                </Empty>
              ) : (
                <>
                  <p className="shrink-0 text-xs font-bold text-zinc-500">
                    {rawQuery.trim()
                      ? `${rawView.matched} of ${rawView.total} lines match.`
                      : `${rawView.total} lines. Cookies, tokens, secrets and signed URLs are removed.`}
                  </p>
                  {rawView.matched === 0 ? (
                    <Empty>Nothing in this metadata matches that search.</Empty>
                  ) : (
                    <pre className="min-h-0 flex-1 overflow-auto rounded border border-white/5 bg-black/40 p-2 text-xs whitespace-pre-wrap wrap-break-word text-zinc-300 select-text">
                      {rawView.text}
                    </pre>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(body, document.body);
};

const RelativeRow: React.FC<{
  kind: string;
  id: string;
  title?: string;
  onReveal: (id: string) => void;
}> = ({ kind, id, title, onReveal }) => (
  <li className="flex items-center gap-2 text-xs font-bold">
    <span className="size-2 shrink-0 rounded-full" style={{ background: edgeColor(kind) }} aria-hidden="true" />
    <span className="shrink-0 text-zinc-500">{relationWords(kind)}</span>
    <button
      type="button"
      className="min-w-0 truncate text-left text-zinc-200 underline decoration-white/20 underline-offset-2 hover:text-purple-200"
      onClick={() => onReveal(id)}
      title={`Select ${title || id} in the library`}
    >
      {title || id}
    </button>
  </li>
);
