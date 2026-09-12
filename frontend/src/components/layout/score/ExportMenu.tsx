/**
 * The SCORE toolbar's one EXPORT control: a button that opens a two-column
 * menu — parts on the left, the formats for the highlighted part on the
 * right. Two columns rather than a flyout submenu because at the toolbar's
 * 8px type a hover-intent submenu is easy to lose; here both levels are
 * visible at once and the whole thing is one role="menu".
 *
 * What the menu offers comes from buildExportMenu (exportMenuModel.ts); this
 * file is the DOM, the keyboard and the focus handling. The Beat Saber
 * popover renders through `children` inside the same anchor so the dialog
 * sits under the EXPORT button; while it is open the menu stays closed.
 *
 * Keyboard: ArrowUp/Down move within a column (disabled entries skipped),
 * Home/End jump within it, ArrowRight goes from a part to its first enabled
 * format, ArrowLeft goes back to the highlighted part, Escape closes and
 * returns focus to the button, Tab closes and lets focus move on.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Download, Gamepad2, Loader2 } from 'lucide-react';
import {
  notationArtifactUrl,
  notationPackUrl,
  type NotationArtifact,
  type NotationCapabilities,
} from '../../../lib/notationClient';
import type { PartDescriptor } from '../../../state/playAlongStore';
import {
  ALL_PARTS,
  buildExportMenu,
  type ExportMenuEntry,
  type ExportMenuPart,
  type SheetExportFormat,
} from './exportMenuModel';

export const EXPORT_TRIGGER_ID = 'score-export-trigger';
export const EXPORT_MENU_ID = 'score-export-menu';

export interface ExportMenuProps {
  artifact: NotationArtifact | null;
  caps: NotationCapabilities | null;
  /** The sheet's parts in score order when something has learnt them; null
   *  until then (the menu asks for them through onOpen). */
  parts: PartDescriptor[] | null;
  /** True while the part list is being read for this sheet. */
  partsLoading: boolean;
  /** The format id of an export in flight, or null. */
  exporting: string | null;
  /** Called when the menu opens, so the owner can go and read the parts. */
  onOpen: () => void;
  onExport: (format: SheetExportFormat) => void;
  /** Open the Beat Saber popover; a part index pre-selects that one part. */
  onOpenBeatSaber: (partIndex: number | null) => void;
  popoverOpen: boolean;
  /** The Beat Saber popover, when open. */
  children?: React.ReactNode;
}

const ITEM_CLS =
  'w-full flex items-center gap-1 px-1.5 py-1 rounded text-left text-[9px] text-zinc-300 hover:bg-white/10 hover:text-zinc-100 transition-colors outline-none focus-visible:bg-white/10 focus-visible:text-zinc-100 focus-visible:ring-1 focus-visible:ring-purple-400/60 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent';

const HEADING_CLS = 'text-[8px] font-mono uppercase tracking-widest text-zinc-600 px-1.5 pb-0.5';

/** A focusable entry that is not disabled; disabled buttons and
 *  aria-disabled spans are skipped by the arrow keys. */
const usable = (el: HTMLElement | null): el is HTMLElement =>
  !!el && !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true';

export const ExportMenu: React.FC<ExportMenuProps> = ({
  artifact,
  caps,
  parts,
  partsLoading,
  exporting,
  onOpen,
  onExport,
  onOpenBeatSaber,
  popoverOpen,
  children,
}) => {
  const [open, setOpen] = useState(false);
  const [highlightedKey, setHighlightedKey] = useState(ALL_PARTS.key);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const partRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const formatRefs = useRef<(HTMLElement | null)[]>([]);

  const artifactId = artifact?.id ?? null;
  const artifactKind = artifact?.kind ?? null;
  const model = useMemo(
    () => buildExportMenu({ artifactKind, caps, parts }),
    [artifactKind, caps, parts],
  );
  const highlighted: ExportMenuPart =
    model.parts.find((p) => p.key === highlightedKey) ?? model.parts[0];
  const formats = model.formatsFor(highlighted);
  const busy = exporting !== null;

  // The menu belongs to one artifact; selecting another closes it and
  // starts again from All parts.
  useEffect(() => {
    setOpen(false);
    setHighlightedKey(ALL_PARTS.key);
  }, [artifactId]);

  // The popover takes over the anchor; one dropdown at a time.
  useEffect(() => {
    if (popoverOpen) setOpen(false);
  }, [popoverOpen]);

  // Outside click closes without moving focus. The trigger is inside
  // rootRef, so the click that opened the menu is not mistaken for an
  // outside one (attaching a listener during the opening click's effect
  // would otherwise close the menu straight away).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  // Focus lands on the highlighted part (All parts on open) so the arrow
  // keys work at once.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const idx = Math.max(0, model.parts.findIndex((p) => p.key === highlightedKey));
      partRefs.current[idx]?.focus();
    });
    return () => cancelAnimationFrame(raf);
    // Only on open: re-running on every highlight change would drag focus
    // back to the parts column while the user is in the formats column.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const openMenu = () => {
    setHighlightedKey(ALL_PARTS.key);
    setOpen(true);
    onOpen();
  };
  const close = () => setOpen(false);
  const closeAndFocusTrigger = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const focusFirstFormat = () => {
    const first = formatRefs.current.find(usable);
    first?.focus();
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      openMenu();
    } else if (open && e.key === 'Escape') {
      e.preventDefault();
      closeAndFocusTrigger();
    }
  };

  // Kept on the panel, not on window: the Beat Saber popover installs its own
  // window Escape listener and the two must not fire for one key.
  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const active = document.activeElement;
    const inFormats = formatRefs.current.some((el) => el === active);
    const column: (HTMLElement | null)[] = inFormats ? formatRefs.current : partRefs.current;
    const usableIdx = column.map((el, i) => (usable(el) ? i : -1)).filter((i) => i >= 0);
    const pos = usableIdx.indexOf(column.findIndex((el) => el === active));
    const focusAt = (k: number) => column[usableIdx[k]]?.focus();

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (usableIdx.length) focusAt(pos < 0 ? 0 : (pos + 1) % usableIdx.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (usableIdx.length) focusAt(pos < 0 ? usableIdx.length - 1 : (pos - 1 + usableIdx.length) % usableIdx.length);
        break;
      case 'Home':
        e.preventDefault();
        if (usableIdx.length) focusAt(0);
        break;
      case 'End':
        e.preventDefault();
        if (usableIdx.length) focusAt(usableIdx.length - 1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (!inFormats) focusFirstFormat();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (inFormats) {
          const idx = Math.max(0, model.parts.findIndex((p) => p.key === highlighted.key));
          partRefs.current[idx]?.focus();
        }
        break;
      case 'Escape':
        e.preventDefault();
        closeAndFocusTrigger();
        break;
      case 'Tab':
        close();
        break;
      default:
        break;
    }
  };

  const choose = (entry: ExportMenuEntry) => {
    if (!entry.enabled) return;
    if (entry.kind === 'popover') {
      // The popover focuses its own first control; no focus return here.
      close();
      onOpenBeatSaber(highlighted.index);
      return;
    }
    if (entry.kind === 'export') {
      closeAndFocusTrigger();
      onExport(entry.id as SheetExportFormat);
    }
  };

  // Refs are rebuilt every render: the format column changes with the part.
  partRefs.current = [];
  formatRefs.current = [];

  const menuOpen = open && !popoverOpen && !!artifact;

  return (
    <span className="relative" ref={rootRef}>
      <button
        type="button"
        id={EXPORT_TRIGGER_ID}
        ref={triggerRef}
        className="btn-ghost text-[8px] py-1 px-1.5 flex items-center gap-1 disabled:opacity-40"
        aria-label="Export"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        // Only while the menu is rendered: aria-controls naming an element
        // that does not exist is worse than none.
        aria-controls={menuOpen ? EXPORT_MENU_ID : undefined}
        disabled={!artifact}
        title="Export this score: pick a part, then a format"
        onClick={() => (open ? closeAndFocusTrigger() : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        {busy ? (
          <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
        ) : (
          <Download className="w-3 h-3" aria-hidden="true" />
        )}
        EXPORT
        <ChevronDown className="w-3 h-3" aria-hidden="true" />
      </button>

      {menuOpen && artifact && (
        <div
          id={EXPORT_MENU_ID}
          role="menu"
          aria-labelledby={EXPORT_TRIGGER_ID}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-full mt-1 z-50 w-72 rounded-lg border border-white/10 bg-[#0a080f] p-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.75)] grid grid-cols-[auto_1fr] gap-1 font-mono text-zinc-300"
        >
          <div role="group" aria-label="Part" className="flex flex-col gap-0.5 w-28 border-r border-white/10 pr-1">
            <span aria-hidden="true" className={HEADING_CLS}>Part</span>
            {model.parts.map((part, i) => {
              const checked = part.key === highlighted.key;
              return (
                <button
                  key={part.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  tabIndex={-1}
                  ref={(el) => {
                    partRefs.current[i] = el;
                  }}
                  className={`${ITEM_CLS} ${checked ? 'bg-purple-500/10 text-purple-200' : ''}`}
                  title={part.index === null ? 'Every part of the sheet' : `Formats that can export ${part.label} on its own`}
                  onMouseEnter={() => setHighlightedKey(part.key)}
                  onFocus={() => setHighlightedKey(part.key)}
                  onClick={() => {
                    setHighlightedKey(part.key);
                    // After React has swapped the format column for this part.
                    requestAnimationFrame(focusFirstFormat);
                  }}
                >
                  <span className="flex-1 min-w-0 truncate">{part.label}</span>
                  {part.isPercussion && (
                    <span className="shrink-0 text-[8px] text-zinc-600" aria-hidden="true">perc</span>
                  )}
                </button>
              );
            })}
            {partsLoading && (
              <span className="text-[8px] text-zinc-500 px-1.5 py-1">Reading parts…</span>
            )}
          </div>

          <div role="group" aria-label={`Format for ${highlighted.label}`} className="flex flex-col gap-0.5 min-w-40">
            <span aria-hidden="true" className={HEADING_CLS}>Format · {highlighted.label}</span>
            {formats.map((entry, i) => {
              const setRef = (el: HTMLElement | null) => {
                formatRefs.current[i] = el;
              };
              if (entry.kind === 'download') {
                if (!entry.enabled) {
                  // A dead link is worse than a disabled item; keep the entry
                  // visible with its reason but give it nothing to follow.
                  return (
                    <span
                      key={entry.id}
                      role="menuitem"
                      aria-disabled="true"
                      tabIndex={-1}
                      ref={setRef}
                      className={`${ITEM_CLS} opacity-40 cursor-not-allowed hover:bg-transparent`}
                      title={entry.title}
                    >
                      <Download className="w-3 h-3 shrink-0" aria-hidden="true" />
                      {entry.label}
                    </span>
                  );
                }
                const href = entry.id === 'pack' ? notationPackUrl(artifact.id) : notationArtifactUrl(artifact.id);
                return (
                  <a
                    key={entry.id}
                    role="menuitem"
                    tabIndex={-1}
                    ref={setRef}
                    href={href}
                    download
                    className={ITEM_CLS}
                    title={entry.title}
                    onClick={closeAndFocusTrigger}
                  >
                    <Download className="w-3 h-3 shrink-0" aria-hidden="true" />
                    {entry.label}
                  </a>
                );
              }
              const disabled = !entry.enabled || busy;
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  ref={setRef}
                  className={ITEM_CLS}
                  disabled={disabled}
                  aria-haspopup={entry.kind === 'popover' ? 'dialog' : undefined}
                  title={entry.enabled && busy ? 'Wait for the running export to finish' : entry.title}
                  onClick={() => choose(entry)}
                >
                  {entry.kind === 'popover' ? (
                    <Gamepad2 className="w-3 h-3 shrink-0 text-rose-300" aria-hidden="true" />
                  ) : exporting === entry.id ? (
                    <Loader2 className="w-3 h-3 shrink-0 animate-spin" aria-hidden="true" />
                  ) : null}
                  {entry.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {children}
    </span>
  );
};

export default ExportMenu;
