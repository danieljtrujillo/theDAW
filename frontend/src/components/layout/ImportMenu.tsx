/**
 * The header's IMPORT control: one button, one place, every tab.
 *
 * Each workspace that plays audio used to reach its own import a different
 * way (a deck drop here, a menu entry there, a HOME card that was never wired
 * up), so the user asked for one control that is always on screen. This is
 * it: a labelled button beside the app menu that opens a small menu with the
 * three things "import" can mean — audio files into the library, a .tasmo
 * project, or a DAW project — and that also takes audio files dropped
 * straight onto it.
 *
 * Wiring notes:
 * - The `data-tour` hook and the drop target both sit on the wrapper, not the
 *   button: TopBarButton takes no data attributes, and the menu is absolutely
 *   positioned, so the wrapper's box is exactly the trigger's — a spotlight
 *   rings the button and a drop anywhere on it lands.
 * - HOME's "Import Audio" reaches the same picker through the
 *   `IMPORT_AUDIO_EVENT` window event. That dispatch, and the listener's
 *   `input.click()`, run synchronously inside HOME's click handler: any await
 *   or timeout before `.click()` leaves the user activation and the browser
 *   silently refuses to open the picker.
 * - The menu mechanics (outside click, Escape back to the trigger, roving
 *   arrows, Tab closes, aria-controls only while rendered) mirror
 *   HamburgerMenu so the two neighbours behave as one.
 */
import React, { useEffect, useRef, useState } from 'react';
import { FileAudio, FolderInput, FolderOpen } from 'lucide-react';
import { TopBarButton } from './TopBarButton';
import { AUDIO_ACCEPT } from '../../lib/fileFilters';
import { importAudioFiles, isAudioFile, type AudioImportOrigin } from '../../lib/importAudioFiles';
import type { LibraryEntry } from '../../state/libraryEntry';
import { useLibraryStore } from '../../state/libraryStore';
import { useAppUiStore } from '../../state/appUiStore';
import { logWarn } from '../../state/logStore';

/** Dispatched (synchronously, from a click) by anything that wants the audio picker. */
export const IMPORT_AUDIO_EVENT = 'thedaw:import-audio';

const MENU_ID = 'header-import-menu';
const INPUT_ID = 'header-import-audio-files';

const PICKER_ORIGIN: AudioImportOrigin = { prompt: 'Imported from file picker', tags: ['imported'] };
const DROP_ORIGIN: AudioImportOrigin = { prompt: 'Imported from header drop', tags: ['imported', 'drop'] };

const ITEM_CLS =
  'w-full flex items-center gap-2 px-2 py-1 rounded text-left text-[10px] text-zinc-300 hover:bg-purple-500/15 hover:text-zinc-100 transition-colors outline-none focus-visible:bg-purple-500/15 focus-visible:text-zinc-100 focus-visible:ring-1 focus-visible:ring-purple-400/60';

export interface ImportMenuProps {
  /** Opens the .tasmo project modal on its Open tab. */
  onOpenProject: () => void;
  /** Opens the DAW (Ableton) import modal. */
  onImportDawProject: () => void;
}

interface MenuAction {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  iconCls: string;
  onSelect: () => void;
}

/**
 * Select the newest entry and open the rail so the user sees the import land.
 * Store state rather than the 'thedaw:reveal-library-entry' event: the rail
 * is unmounted while closed, so its listener does not exist in the same tick
 * that opens it. The library's default sort is 'newest', so the selected
 * entry heads the list.
 */
const landInLibrary = (entries: LibraryEntry[]) => {
  const last = entries[entries.length - 1];
  if (!last) return;
  useLibraryStore.getState().setSelectedEntry(last.id);
  useAppUiStore.getState().setRightPanelOpen(true);
};

const runImport = async (files: File[], origin: AudioImportOrigin) => {
  const audio = files.filter(isAudioFile);
  const skipped = files.length - audio.length;
  if (skipped > 0) logWarn('import', `${skipped} non-audio file(s) skipped`);
  if (audio.length === 0) return;
  const { imported } = await importAudioFiles(audio, origin);
  landInLibrary(imported);
};

const hasFiles = (dt: DataTransfer) => Array.from(dt.types).includes('Files');

export const ImportMenu: React.FC<ImportMenuProps> = ({ onOpenProject, onImportDawProject }) => {
  const [open, setOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const openPicker = () => fileInputRef.current?.click();

  const items: MenuAction[] = [
    { id: 'audio', label: 'Audio files… (to the library)', icon: FileAudio, iconCls: 'text-emerald-300', onSelect: openPicker },
    { id: 'project', label: 'Open project… (.tasmo)', icon: FolderOpen, iconCls: 'text-sky-300', onSelect: onOpenProject },
    { id: 'daw', label: 'DAW project… (Ableton)', icon: FolderInput, iconCls: 'text-sky-300', onSelect: onImportDawProject },
  ];

  // Close on outside click + Escape while the menu is open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Move focus into the menu when it opens (roving focus for arrow keys).
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  // HOME's Import Audio (and anything else) asks for the picker by event.
  useEffect(() => {
    const onRequest = () => openPicker();
    window.addEventListener(IMPORT_AUDIO_EVENT, onRequest);
    return () => window.removeEventListener(IMPORT_AUDIO_EVENT, onRequest);
  }, []);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const count = items.length;
    const idx = itemRefs.current.findIndex((el) => el === document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      itemRefs.current[idx < 0 ? 0 : (idx + 1) % count]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      itemRefs.current[idx < 0 ? count - 1 : (idx - 1 + count) % count]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      itemRefs.current[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      itemRefs.current[count - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  // Close first, then act: the picker's click must still be inside the user
  // activation, and so must the modal opens, so nothing here is deferred.
  const selectItem = (item: MenuAction) => {
    setOpen(false);
    item.onSelect();
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    // Reset so picking the same file again still fires onChange.
    e.target.value = '';
    void runImport(files, PICKER_ORIGIN);
  };

  // Files only: a library-entry drag (its own mime) must not light the button.
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  };
  const onDragLeave = () => setDragOver(false);
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    setDragOver(false);
    void runImport(Array.from(e.dataTransfer.files), DROP_ORIGIN);
  };

  return (
    <div
      data-tour="import"
      ref={rootRef}
      className="relative"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <TopBarButton
        buttonRef={triggerRef}
        onClick={() => setOpen((v) => !v)}
        icon={<FolderInput className="w-3.5 h-3.5" aria-hidden="true" />}
        label="Import"
        title="Import audio files, a .tasmo project or a DAW project — or drop audio files here"
        accent="sky"
        active={open || dragOver}
        ariaHasPopup="menu"
        ariaExpanded={open}
        ariaControls={open ? MENU_ID : undefined}
      />
      {/* The native picker. Hidden, but a real labelled field: the sr-only
          label is what a screen reader names it by. AUDIO_ACCEPT rather than
          a bare audio/* so an empty-mime .wav is not greyed out on Windows. */}
      <label htmlFor={INPUT_ID} className="sr-only">
        Audio files to import
      </label>
      <input
        ref={fileInputRef}
        id={INPUT_ID}
        name={INPUT_ID}
        type="file"
        accept={AUDIO_ACCEPT}
        multiple
        className="hidden"
        onChange={onFileChange}
      />

      {open && (
        <div
          id={MENU_ID}
          role="menu"
          aria-label="Import"
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-full mt-1 z-50 w-56 bg-[#0a080f] border border-white/10 rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.75)] p-1.5 flex flex-col gap-0.5"
        >
          {items.map((item, i) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                onClick={() => selectItem(item)}
                className={ITEM_CLS}
              >
                <Icon className={`w-3.5 h-3.5 shrink-0 ${item.iconCls}`} />
                <span className="flex-1 min-w-0 truncate">{item.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
