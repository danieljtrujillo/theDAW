/**
 * The asset library: a searchable browser over everything downloadable.
 *
 * The catalog is served by backend/modules/assets. Items are projects
 * (.tasmo), plugins (.gan), volumetric captures (.ares) and cockpit scenes
 * (.sway). Install puts the file where its format belongs and reports the
 * path; download hands the raw file over for use elsewhere.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Box,
  Check,
  Download,
  FileMusic,
  Layers,
  Loader2,
  GripVertical,
  Package,
  Search,
  Waves,
  X,
} from 'lucide-react';
import { logError, logInfo } from '../../state/logStore';

interface Asset {
  id: string;
  name: string;
  kind: string;
  format: string;
  summary: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
  tabs: string[];
  requires: string[];
  duration_sec: number | null;
  available: boolean;
  size_bytes: number;
  has_cover: boolean;
  download_url: string;
  cover_url: string;
  installs_to?: string;
}

interface Facet {
  value: string;
  count: number;
}

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  project: FileMusic,
  plugin: Package,
  volumetric: Box,
  scene: Waves,
};

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_W = 520;
const MIN_H = 340;

/** A panel the size of most of the window, centred, never off an edge. */
const initialRect = (): Rect => {
  const w = Math.max(MIN_W, Math.min(1120, window.innerWidth - 80));
  const h = Math.max(MIN_H, Math.min(720, window.innerHeight - 120));
  return {
    x: Math.max(8, Math.round((window.innerWidth - w) / 2)),
    y: Math.max(8, Math.round((window.innerHeight - h) / 2)),
    w,
    h,
  };
};

const clampRect = (r: Rect): Rect => {
  const w = Math.max(MIN_W, Math.min(r.w, window.innerWidth - 16));
  const h = Math.max(MIN_H, Math.min(r.h, window.innerHeight - 16));
  return {
    w,
    h,
    // A title bar dragged past the bottom edge cannot be grabbed again, so the
    // panel stays reachable by construction rather than by the user's care.
    x: Math.max(8 - w + 120, Math.min(r.x, window.innerWidth - 120)),
    y: Math.max(8, Math.min(r.y, window.innerHeight - 44)),
  };
};

const fmtSize = (bytes: number): string =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

const fmtDuration = (sec: number | null): string => {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

export const AssetLibraryModal: React.FC<{ open: boolean; onClose: () => void }> = ({
  open,
  onClose,
}) => {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [kinds, setKinds] = useState<Facet[]>([]);
  const [tabs, setTabs] = useState<Facet[]>([]);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [tab, setTab] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Asset | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState<Record<string, string>>({});
  const [rect, setRect] = useState<Rect>(initialRect);
  // The gesture in flight. A ref, not state: it changes on every pointermove
  // and nothing renders from it.
  const drag = useRef<{ mode: 'move' | 'resize'; x: number; y: number; rect: Rect } | null>(null);

  // Opening recentres, so a panel left somewhere awkward, or a window resized
  // while it was closed, does not open off screen.
  useEffect(() => {
    if (open) setRect(initialRect());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => setRect((r) => clampRect(r));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

  const startGesture = useCallback(
    (mode: 'move' | 'resize') => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { mode, x: e.clientX, y: e.clientY, rect };
    },
    [rect],
  );

  const onGesturePointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    setRect(
      clampRect(
        d.mode === 'move'
          ? { ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy }
          : { ...d.rect, w: d.rect.w + dx, h: d.rect.h + dy },
      ),
    );
  }, []);

  const endGesture = useCallback((e: React.PointerEvent) => {
    drag.current = null;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (kind) params.set('kind', kind);
      if (tab) params.set('tab', tab);
      const r = await fetch(`/api/assets?${params.toString()}`);
      if (!r.ok) throw new Error(await r.text());
      const j = (await r.json()) as { assets: Asset[] };
      setAssets(j.assets);
    } catch (e) {
      logError('assets', `Could not read the asset catalog: ${e instanceof Error ? e.message : String(e)}`);
      setAssets([]);
    } finally {
      setLoading(false);
    }
  }, [query, kind, tab]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    void fetch('/api/assets/facets')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j) return;
        setKinds(j.kinds ?? []);
        setTabs(j.tabs ?? []);
      })
      .catch(() => undefined);
  }, [open]);

  // The list view carries enough to browse; the detail call adds the install
  // path, which the server is the only one that knows.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void fetch(`/api/assets/${encodeURIComponent(selectedId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j) setDetail(j as Asset);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const install = useCallback(async (asset: Asset) => {
    setInstalling(true);
    try {
      const r = await fetch(`/api/assets/${encodeURIComponent(asset.id)}/install`, { method: 'POST' });
      if (!r.ok) throw new Error(await r.text());
      const j = (await r.json()) as { path: string; where: string };
      setInstalled((prev) => ({ ...prev, [asset.id]: j.path }));
      logInfo('assets', `Installed ${asset.name} to ${j.path}`);
    } catch (e) {
      logError('assets', `Install failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setInstalling(false);
    }
  }, []);

  const selected = useMemo(
    () => detail ?? assets.find((a) => a.id === selectedId) ?? null,
    [detail, assets, selectedId],
  );

  if (!open) return null;

  // Rendered into document.body. The Shell carries a CSS `zoom`, and a fixed
  // element inside a zoomed ancestor is laid out in the zoomed coordinate
  // space: without the portal this panel opens offset and oversized, past the
  // window edges, which is exactly what it did.
  return createPortal(
    <div
      role="dialog"
      aria-label="Asset library"
      aria-modal="true"
      className="fixed inset-0 z-50"
    >
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div
        className="absolute flex flex-col overflow-hidden rounded-lg border border-purple-500/30 bg-[#0a080f] shadow-2xl"
        style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      >
        <div
          className="flex shrink-0 cursor-grab touch-none select-none items-center gap-3 border-b border-white/10 px-3 py-2 active:cursor-grabbing"
          onPointerDown={startGesture('move')}
          onPointerMove={onGesturePointerMove}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
        >
          <Layers className="h-4 w-4 text-purple-300" />
          <h2 className="text-[11px] font-black uppercase tracking-widest text-purple-200">
            Asset library
          </h2>
          <div
            className="relative ml-3 grow max-w-md"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-500" />
            <input
              id="asset-search"
              name="asset-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects, plugins, scenes"
              aria-label="Search the asset library"
              className="w-full rounded border border-white/10 bg-black/40 py-1 pl-7 pr-2 text-[10px] font-mono text-zinc-200 outline-none focus:border-purple-500/50"
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label="Close the asset library"
            className="ml-auto rounded p-1 text-zinc-400 hover:text-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-white/5 px-3 py-1.5">
          <FilterChip label="All" active={!kind} onClick={() => setKind('')} />
          {kinds.map((f) => (
            <FilterChip
              key={f.value}
              label={`${f.value} ${f.count}`}
              active={kind === f.value}
              onClick={() => setKind(kind === f.value ? '' : f.value)}
            />
          ))}
          {tabs.length > 0 && <span className="mx-1 h-3 w-px bg-white/10" />}
          {tabs.map((f) => (
            <FilterChip
              key={f.value}
              label={f.value}
              active={tab === f.value}
              onClick={() => setTab(tab === f.value ? '' : f.value)}
            />
          ))}
        </div>

        <div className="flex min-h-0 grow">
          <div className="min-w-0 grow overflow-y-auto p-3">
            {loading && (
              <p className="text-[10px] font-mono text-zinc-500">Reading the catalog…</p>
            )}
            {!loading && assets.length === 0 && (
              <p className="text-[10px] font-mono text-zinc-500">
                Nothing matches that search.
              </p>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {assets.map((a) => {
                const Icon = KIND_ICON[a.kind] ?? Package;
                const isSel = a.id === selectedId;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setSelectedId(a.id)}
                    aria-pressed={isSel}
                    className={`flex flex-col overflow-hidden rounded border text-left transition-colors ${
                      isSel
                        ? 'border-purple-400/60 bg-purple-500/10'
                        : 'border-white/10 bg-black/30 hover:border-purple-400/30'
                    }`}
                  >
                    {a.has_cover ? (
                      <img
                        src={a.cover_url}
                        alt=""
                        className="h-24 w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="flex h-24 w-full items-center justify-center bg-white/3">
                        <Icon className="h-6 w-6 text-zinc-600" />
                      </div>
                    )}
                    <div className="flex flex-col gap-1 p-2">
                      <div className="flex items-center gap-1.5">
                        <Icon className="h-3 w-3 shrink-0 text-purple-300" />
                        <span className="truncate text-[11px] font-bold text-zinc-100">{a.name}</span>
                        {installed[a.id] && <Check className="ml-auto h-3 w-3 text-emerald-400" />}
                      </div>
                      <p className="line-clamp-2 text-[9px] font-mono leading-snug text-zinc-400">
                        {a.summary}
                      </p>
                      <div className="flex items-center gap-1.5 text-[8px] font-mono uppercase tracking-widest text-zinc-600">
                        <span>{a.format.replace('.', '')}</span>
                        <span>{fmtSize(a.size_bytes)}</span>
                        {a.duration_sec ? <span>{fmtDuration(a.duration_sec)}</span> : null}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {selected && (
            <aside className="w-80 shrink-0 overflow-y-auto border-l border-white/10 bg-black/40 p-3">
              <h3 className="text-[13px] font-black text-zinc-100">{selected.name}</h3>
              <p className="mt-0.5 text-[9px] font-mono uppercase tracking-widest text-zinc-500">
                {selected.kind} · {selected.format.replace('.', '')} · {fmtSize(selected.size_bytes)}
                {selected.author ? ` · ${selected.author}` : ''}
              </p>
              <p className="mt-2 text-[10px] leading-relaxed text-zinc-300">{selected.description}</p>

              {selected.tabs.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {selected.tabs.map((t) => (
                    <span
                      key={t}
                      className="rounded border border-purple-500/30 px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-widest text-purple-200"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
              {selected.tags.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {selected.tags.map((t) => (
                    <span
                      key={t}
                      className="rounded border border-white/10 px-1.5 py-0.5 text-[8px] font-mono text-zinc-500"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-3 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void install(selected)}
                  disabled={installing || !selected.available}
                  className="btn-ghost flex items-center gap-1 text-[9px] disabled:opacity-40"
                >
                  {installing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3 text-emerald-300" />}
                  INSTALL
                </button>
                <a
                  href={selected.download_url}
                  download
                  className="btn-ghost flex items-center gap-1 text-[9px]"
                >
                  <Download className="h-3 w-3 text-purple-300" /> DOWNLOAD
                </a>
              </div>

              {selected.installs_to && (
                <p className="mt-2 text-[9px] font-mono text-zinc-500">
                  Installs to {selected.installs_to}
                </p>
              )}
              {installed[selected.id] && (
                <p className="mt-1 text-[9px] font-mono text-emerald-300">
                  Installed at {installed[selected.id]}
                </p>
              )}
            </aside>
          )}
        </div>

        {/* Bottom-right resize grip. A button so it takes focus and announces
            itself; keyboard sizing is the arrow keys on it. */}
        <button
          type="button"
          aria-label="Resize the asset library"
          onPointerDown={startGesture('resize')}
          onPointerMove={onGesturePointerMove}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 64 : 16;
            const by = (dw: number, dh: number) => {
              e.preventDefault();
              setRect((r) => clampRect({ ...r, w: r.w + dw, h: r.h + dh }));
            };
            if (e.key === 'ArrowRight') by(step, 0);
            else if (e.key === 'ArrowLeft') by(-step, 0);
            else if (e.key === 'ArrowDown') by(0, step);
            else if (e.key === 'ArrowUp') by(0, -step);
          }}
          className="absolute bottom-0 right-0 flex h-4 w-4 cursor-nwse-resize touch-none items-center justify-center text-zinc-600 hover:text-purple-300"
        >
          <GripVertical className="h-3 w-3 rotate-45" />
        </button>
      </div>
    </div>,
    document.body,
  );
};

const FilterChip: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({
  label,
  active,
  onClick,
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`rounded border px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-widest transition-colors ${
      active
        ? 'border-purple-400/60 bg-purple-500/15 text-purple-200'
        : 'border-white/10 text-zinc-500 hover:text-zinc-200'
    }`}
  >
    {label}
  </button>
);
