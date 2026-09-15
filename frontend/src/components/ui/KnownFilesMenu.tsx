/**
 * A "Recent" button that offers files the app already knows the location of.
 *
 * Sits beside a file input. The backend records every path the app itself
 * wrote or picked (a save, a finished download, an asset install, a native
 * pick); this lists the ones it will serve that match the input's extensions,
 * and choosing one hands the same handler the input feeds a real File. Each row
 * can also show its file in the OS file manager. With several `kinds`, each
 * kind is fetched and the rows are merged, one per path, newest first.
 *
 * Renders nothing until there is at least one matching file, and refetches
 * when it opens, when the window regains focus, and whenever a save or a
 * download reports a new path.
 *
 * The popup portals to document.body so a clipping toolbar or modal body never
 * cuts it off. The Shell's CSS `zoom` does not apply there, and current
 * Chromium reports getBoundingClientRect in viewport pixels, so the trigger's
 * rect positions it directly (see the note in ContextMenu.tsx).
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpen, History, Loader2 } from 'lucide-react';
import {
  PLACES_CHANGED_EVENT,
  dirnameOf,
  fileFromPlace,
  isLocalClient,
  normalizeExts,
  placesApi,
  type PlaceItem,
} from '../../lib/placesClient';
import { logError } from '../../state/logStore';

interface KnownFilesMenuProps {
  /** Id of the trigger button; the listbox and its options derive theirs from it. */
  id: string;
  /** Accepted extensions, e.g. ['.mid', '.midi']. */
  exts: string[];
  /** known_paths kinds to include; every kind when omitted. */
  kinds?: string[];
  /** Names the trigger and its list ("Recent audio" → "Recent audio files").
   *  It is never printed: the trigger is the clock icon, and the word travels
   *  in the accessible name and the tooltip. */
  label?: string;
  /** The trigger's and the list's accessible name; defaults to "<label> files". */
  name?: string;
  onFiles: (files: File[]) => void;
  /** `flyout` prints the trigger's legend at 12px, for a trigger inside a flyout card. */
  size?: 'compact' | 'flyout';
  className?: string;
}

const MAX_ROWS = 15;
const POPUP_MIN_WIDTH = 224;

function formatWhen(at: number): string {
  const secs = Math.max(0, Date.now() / 1000 - at);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return new Date(at * 1000).toLocaleDateString();
}

export const KnownFilesMenu: React.FC<KnownFilesMenuProps> = ({
  id,
  exts,
  kinds,
  label = 'Recent',
  name,
  onFiles,
  size = 'compact',
  className = '',
}) => {
  const [items, setItems] = useState<PlaceItem[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusPendingRef = useRef(false);
  const seqRef = useRef(0);

  const listId = `${id}-listbox`;
  const menuName = name ?? `${label} files`;
  const local = isLocalClient();

  // String keys, so a caller passing an inline array does not refetch on
  // every render.
  const extKey = normalizeExts(exts).join(',');
  const kindKey = (kinds ?? []).join(',');

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    const extList = extKey ? extKey.split(',') : [];
    const kindList = kindKey ? kindKey.split(',') : [];
    const rows = await placesApi.recentOfKinds({ kinds: kindList, exts: extList, limit: 30 });
    if (seq !== seqRef.current) return;
    const matched = rows.filter((r) => r.servable).slice(0, MAX_ROWS);
    setItems(matched);
    if (matched.length === 0) setOpen(false);
  }, [extKey, kindKey]);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener(PLACES_CHANGED_EVENT, onChange);
    window.addEventListener('focus', onChange);
    return () => {
      seqRef.current += 1;
      window.removeEventListener(PLACES_CHANGED_EVENT, onChange);
      window.removeEventListener('focus', onChange);
    };
  }, [refresh]);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setError(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const toggle = () => {
    if (open) {
      close(false);
      return;
    }
    setError(null);
    setActiveIdx(0);
    focusPendingRef.current = true;
    setOpen(true);
    void refresh();
  };

  // Place the popup under the trigger, flipped above it or pulled left when
  // it would leave the viewport. The first paint renders off-screen.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (!trigger || !popup) return;
    const r = trigger.getBoundingClientRect();
    const p = popup.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 6;
    let left = r.left;
    if (left + p.width + pad > vw) left = Math.max(pad, vw - p.width - pad);
    let top = r.bottom + 4;
    if (top + p.height + pad > vh) top = Math.max(pad, r.top - p.height - 4);
    setPos({ left, top });
  }, [open, items, error]);

  // Move focus into the list once it is visible, so arrow keys work at once.
  useEffect(() => {
    if (!open || !pos || !focusPendingRef.current || items.length === 0) return;
    focusPendingRef.current = false;
    optionRefs.current[0]?.focus({ preventScroll: true });
  }, [open, pos, items]);

  // Outside click, Escape, a scroll outside the popup, or a resize closes it.
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      Boolean(popupRef.current?.contains(target) || triggerRef.current?.contains(target));
    const onDown = (e: MouseEvent) => {
      if (!inside(e.target)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Node && popupRef.current?.contains(e.target))) close(false);
    };
    const onResize = () => close(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  const choose = async (item: PlaceItem) => {
    if (busyPath) return;
    setBusyPath(item.path);
    setError(null);
    try {
      const file = await fileFromPlace(item);
      // Close first, so a handler that switches tabs or opens a modal does
      // not leave the popup hanging over the new surface.
      close(true);
      onFiles([file]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      logError('files', `Could not open ${item.name}: ${msg}`);
    } finally {
      setBusyPath(null);
    }
  };

  const reveal = async (item: PlaceItem) => {
    setError(null);
    try {
      await placesApi.reveal(item.path);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      logError('files', `Could not show ${item.path}: ${msg}`);
    }
  };

  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const n = items.length;
    if (!n) return;
    const current = Math.min(activeIdx, n - 1);
    let next = -1;
    if (e.key === 'ArrowDown') next = (current + 1) % n;
    else if (e.key === 'ArrowUp') next = (current - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next < 0) return;
    e.preventDefault();
    setActiveIdx(next);
    optionRefs.current[next]?.focus({ preventScroll: false });
  };

  // Focus leaving the popup for another control closes it. A null target is
  // the window losing focus (Explorer opening from "Show in folder"), which
  // keeps it open.
  const onPopupBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget;
    if (next === null) return;
    if (next instanceof Node && (popupRef.current?.contains(next) || triggerRef.current?.contains(next))) return;
    close(false);
  };

  if (items.length === 0) return null;

  optionRefs.current.length = items.length;
  const active = Math.min(activeIdx, items.length - 1);

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={menuName}
        title={`${menuName}: recent files this app saved, installed, opened or downloaded.`}
        className={`shrink-0 inline-flex items-center justify-center rounded border border-white/10 bg-white/5 px-1.5 py-1 text-zinc-300 hover:text-[rgb(var(--et-accent))] hover:shadow-[inset_0_0_0_100px_rgba(255,255,255,0.06)] transition-colors ${className}`}
      >
        {/* The clock alone. The word travels in aria-label and the tooltip:
            the user asked for these triggers to be their icon. */}
        <History className="w-3.5 h-3.5" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popupRef}
            className="fixed z-400 rounded border border-white/10 bg-[#0a080f] shadow-[0_8px_24px_rgba(0,0,0,0.6)]"
            style={{
              left: pos?.left ?? -9999,
              top: pos?.top ?? -9999,
              minWidth: POPUP_MIN_WIDTH,
              maxWidth: 'min(28rem, 92vw)',
            }}
            onBlur={onPopupBlur}
          >
            <div className="flex max-h-72 overflow-y-auto">
              <div
                id={listId}
                role="listbox"
                aria-label={menuName}
                onKeyDown={onListKeyDown}
                className="flex min-w-0 flex-1 flex-col"
              >
                {items.map((item, i) => (
                  <button
                    key={item.path}
                    ref={(el) => {
                      optionRefs.current[i] = el;
                    }}
                    id={`${id}-opt-${i}`}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    tabIndex={i === active ? 0 : -1}
                    onFocus={() => setActiveIdx(i)}
                    onClick={() => void choose(item)}
                    title={item.path}
                    className={`flex h-9 w-full flex-col justify-center border-b border-white/5 px-2 text-left last:border-b-0 hover:shadow-[inset_0_0_0_100px_rgba(255,255,255,0.06)] focus:outline-none focus-visible:shadow-[inset_0_0_0_100px_rgba(255,255,255,0.08)] ${
                      i === active ? 'text-[rgb(var(--et-accent))]' : 'text-zinc-200'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      {busyPath === item.path && <Loader2 className="w-3 h-3 shrink-0 animate-spin" />}
                      <span className="truncate text-[12px] font-semibold leading-4">{item.name}</span>
                    </span>
                    <span className="truncate text-[12px] font-semibold leading-4 text-zinc-500">
                      {formatWhen(item.at)} · {dirnameOf(item.path)}
                    </span>
                  </button>
                ))}
              </div>
              {local && (
                <div className="flex shrink-0 flex-col border-l border-white/5">
                  {items.map((item) => (
                    <button
                      key={item.path}
                      type="button"
                      onClick={() => void reveal(item)}
                      aria-label={`Show ${item.name} in folder`}
                      title="Shows this file in its folder."
                      className="inline-flex h-9 w-8 items-center justify-center border-b border-white/5 text-zinc-400 last:border-b-0 hover:shadow-[inset_0_0_0_100px_rgba(255,255,255,0.06)] hover:text-[rgb(var(--et-accent))]"
                    >
                      <FolderOpen className="w-3 h-3" />
                    </button>
                  ))}
                </div>
              )}
            </div>
            {error && (
              <p role="alert" className="border-t border-white/5 px-2 py-1.5 text-[12px] font-semibold leading-snug text-red-300">
                {error}
              </p>
            )}
          </div>,
          document.body,
        )}
    </>
  );
};
