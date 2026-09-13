import React, { useEffect, useRef, useState } from 'react';
import {
  Archive,
  BookOpen,
  Compass,
  ExternalLink,
  FilePlus2,
  FolderInput,
  FolderOpen,
  Headset,
  History,
  Home,
  Layers,
  LayoutGrid,
  Menu,
  Palette,
  RefreshCw,
  Save,
  Settings,
  StickyNote,
} from 'lucide-react';
import { useFeatureNoteStore } from '../../onboarding/featureNoteStore';
import { FEATURE_NOTES } from '../../onboarding/featureNoteList';
import { AssetLibraryModal } from '../assets/AssetLibraryModal';
import { BackupModal } from './BackupModal';
import { UpdateModal } from './UpdateModal';
import { QuestDeployModal } from './QuestDeployModal';
import { ThemeModal } from './ThemeModal';

export interface HamburgerMenuProps {
  onNewProject: () => void;
  onOpenProject: () => void;
  onSaveProject: () => void;
  onImportDawProject: () => void;
  onToggleEditLayout: () => void;
  editLayoutActive: boolean;
  onOpenSettings: () => void;
  onOpenDocs: () => void;
  onStartTour: () => void;
  onOpenHome: () => void;
}

interface MenuAction {
  id: string;
  label: string;
  /** Omitted by rows that carry no icon (the sponsor row). */
  icon?: React.ComponentType<{ className?: string }>;
  iconCls: string;
  onSelect: () => void;
  /** Row shows an accent dot when the underlying toggle is on (Edit Layout). */
  active?: boolean;
  /** Sponsor row: purple-filled, so it reads as an offer and not a setting. */
  accent?: boolean;
  /** Trailing arrow + native tooltip for rows that leave the app. */
  external?: boolean;
  title?: string;
}

interface MenuSection {
  label: string;
  items: MenuAction[];
}

/* Trigger styling mirrors the header icon cluster's TopBarButton (purple accent). */
const TRIGGER_IDLE =
  'border-purple-500/30 hover:bg-purple-500/15 shadow-[0_0_10px_rgba(168,85,247,0.3)] text-purple-300 hover:text-purple-200';
const TRIGGER_ACTIVE =
  'border-purple-500/50 bg-purple-500/15 text-purple-200 shadow-[0_0_12px_rgba(168,85,247,0.45)]';

const ITEM_CLS =
  'w-full flex items-center gap-2 px-2 py-1 rounded text-left text-[10px] text-zinc-300 hover:bg-purple-500/15 hover:text-zinc-100 transition-colors outline-none focus-visible:bg-purple-500/15 focus-visible:text-zinc-100 focus-visible:ring-1 focus-visible:ring-purple-400/60';
/* The sponsor row: no icon, label centred in the row rather than left-aligned
   with the rest of the menu. */
const ITEM_ACCENT_CLS =
  'justify-center border border-purple-400/50 bg-purple-500/20 text-purple-100 font-black uppercase tracking-wider hover:bg-purple-500/30 hover:text-white';

/** Where every Sponsor entry points: the hamburger row here, the pinned row in
 *  Settings, the README badge, .github/FUNDING.yml and the Pinokio menu. */
const SPONSOR_URL = 'https://github.com/sponsors/gantasmo';
const SPONSOR_TITLE =
  'theDAW is independent and self-funded. A sponsorship keeps development going (food, coffee, and compute) and flows straight back into the software.';

/**
 * App hamburger menu for the top header: project open/save, backup/migrate,
 * update check/restore, layout + settings + docs, and help entries. The
 * Backup and Update modals are owned here and rendered via portals, so the
 * shell only wires the callback props.
 */
export const HamburgerMenu: React.FC<HamburgerMenuProps> = ({
  onNewProject,
  onOpenProject,
  onSaveProject,
  onImportDawProject,
  onToggleEditLayout,
  editLayoutActive,
  onOpenSettings,
  onOpenDocs,
  onStartTour,
  onOpenHome,
}) => {
  const [open, setOpen] = useState(false);
  // "Hide" only while a note is actually on screen; once they are all closed
  // the entry reads "Show" and brings the whole set back.
  const notesEnabled = useFeatureNoteStore((s) => s.enabled);
  const notesDismissed = useFeatureNoteStore((s) => s.dismissed);
  const notesShown = notesEnabled && notesDismissed.length < FEATURE_NOTES.length;
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateShowsReleases, setUpdateShowsReleases] = useState(false);
  const [questOpen, setQuestOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const sections: MenuSection[] = [
    {
      label: 'Project',
      items: [
        { id: 'new-project', label: 'New Project', icon: FilePlus2, iconCls: 'text-sky-300', onSelect: onNewProject },
        { id: 'open-project', label: 'Open Project', icon: FolderOpen, iconCls: 'text-sky-300', onSelect: onOpenProject },
        { id: 'save-project', label: 'Save Project', icon: Save, iconCls: 'text-sky-300', onSelect: onSaveProject },
        { id: 'import-daw', label: 'Import DAW Project', icon: FolderInput, iconCls: 'text-sky-300', onSelect: onImportDawProject },
      ],
    },
    {
      label: 'Data',
      items: [
        {
          id: 'asset-library',
          label: 'Asset Library',
          icon: Layers,
          iconCls: 'text-emerald-300',
          onSelect: () => setAssetsOpen(true),
        },
        {
          id: 'backup-migrate',
          label: 'Backup / Migrate',
          icon: Archive,
          iconCls: 'text-emerald-300',
          onSelect: () => setBackupOpen(true),
        },
        {
          id: 'check-updates',
          label: 'Check for Updates',
          icon: RefreshCw,
          iconCls: 'text-emerald-300',
          onSelect: () => {
            setUpdateShowsReleases(false);
            setUpdateOpen(true);
          },
        },
        {
          id: 'restore-version',
          label: 'Restore Previous Version',
          icon: History,
          iconCls: 'text-emerald-300',
          onSelect: () => {
            setUpdateShowsReleases(true);
            setUpdateOpen(true);
          },
        },
      ],
    },
    {
      label: 'Devices',
      items: [
        {
          id: 'deploy-quest',
          label: 'Deploy to Quest',
          icon: Headset,
          iconCls: 'text-sky-300',
          onSelect: () => setQuestOpen(true),
        },
      ],
    },
    {
      label: 'App',
      items: [
        {
          id: 'edit-layout',
          label: 'Edit Layout',
          icon: LayoutGrid,
          iconCls: 'text-purple-300',
          onSelect: onToggleEditLayout,
          active: editLayoutActive,
        },
        { id: 'change-theme', label: 'Change Theme', icon: Palette, iconCls: 'text-teal-300', onSelect: () => setThemeOpen(true) },
        { id: 'settings', label: 'Settings', icon: Settings, iconCls: 'text-rose-300', onSelect: onOpenSettings },
        { id: 'docs', label: 'Docs', icon: BookOpen, iconCls: 'text-purple-300', onSelect: onOpenDocs },
      ],
    },
    {
      label: 'Help',
      items: [
        { id: 'feature-tour', label: 'Feature Tour', icon: Compass, iconCls: 'text-amber-300', onSelect: onStartTour },
        {
          id: 'feature-notes',
          label: notesShown ? 'Hide Feature Notes' : 'Show Feature Notes',
          icon: StickyNote,
          iconCls: 'text-amber-300',
          // Showing brings back every note, dismissed ones included: the point
          // of the entry is to re-find a control you have since forgotten.
          onSelect: () =>
            notesShown
              ? useFeatureNoteStore.getState().setEnabled(false)
              : useFeatureNoteStore.getState().resetAll(),
        },
        { id: 'home-screen', label: 'Home Screen', icon: Home, iconCls: 'text-amber-300', onSelect: onOpenHome },
      ],
    },
    {
      label: 'Support',
      items: [
        {
          id: 'sponsor',
          label: 'Sponsor theDAW',
          iconCls: '',
          accent: true,
          external: true,
          title: SPONSOR_TITLE,
          // In the desktop app window.open is intercepted by the main process
          // (setWindowOpenHandler -> shell.openExternal), so this opens the
          // system browser there and a new tab in the browser build.
          onSelect: () => window.open(SPONSOR_URL, '_blank', 'noopener,noreferrer'),
        },
      ],
    },
  ];
  const flatItems = sections.flatMap((s) => s.items);

  // Close on outside click + Escape while the dropdown is open.
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

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const count = flatItems.length;
    if (count === 0) return;
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

  // Focus goes back to the trigger before the action runs, as it does on
  // Escape: the focused item unmounts with the menu, and an item that opens
  // no modal (Edit Layout, Show/Hide Feature Notes) would otherwise leave
  // focus on <body>. Items that open a modal take focus into their dialog
  // from there.
  const selectItem = (item: MenuAction) => {
    setOpen(false);
    triggerRef.current?.focus();
    item.onSelect();
  };

  // Flat index cursor so refs line up across sections.
  let flatIndex = -1;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        title="App menu"
        aria-label="App menu"
        aria-haspopup="menu"
        aria-expanded={open}
        // Only while the menu is actually rendered: aria-controls naming an
        // element that does not exist is worse than no aria-controls at all.
        aria-controls={open ? 'app-hamburger-menu' : undefined}
        className={`p-1.5 rounded border transition-colors group flex items-center gap-1.5 outline-none focus-visible:ring-1 focus-visible:ring-purple-400/60 ${
          open ? TRIGGER_ACTIVE : TRIGGER_IDLE
        }`}
      >
        <Menu className="w-3.5 h-3.5" />
      </button>

      {open && (
        <div
          id="app-hamburger-menu"
          role="menu"
          aria-label="App menu"
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-full mt-1 z-50 w-56 bg-[#0a080f] border border-white/10 rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.75)] p-1.5 flex flex-col gap-0.5"
        >
          {sections.map((section, si) => (
            <div key={section.label} role="group" aria-label={section.label} className="flex flex-col gap-0.5">
              <div
                aria-hidden="true"
                className={`flex items-center gap-1.5 px-1 pb-0.5 ${si === 0 ? 'pt-0.5' : 'pt-1'}`}
              >
                <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-600">
                  {section.label}
                </span>
                <div className="flex-1 h-px bg-white/10" />
              </div>
              {section.items.map((item) => {
                flatIndex += 1;
                const refIndex = flatIndex;
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    ref={(el) => {
                      itemRefs.current[refIndex] = el;
                    }}
                    onClick={() => selectItem(item)}
                    title={item.title}
                    className={`${ITEM_CLS} ${item.accent ? ITEM_ACCENT_CLS : ''} ${
                      item.active ? 'bg-purple-500/10 text-purple-200' : ''
                    }`}
                  >
                    {Icon && <Icon className={`w-3.5 h-3.5 shrink-0 ${item.iconCls}`} />}
                    <span
                      className={
                        item.accent ? 'min-w-0 truncate' : 'flex-1 min-w-0 truncate'
                      }
                    >
                      {item.label}
                    </span>
                    {item.external && <ExternalLink className="w-3 h-3 opacity-70 shrink-0" />}
                    {item.active && <span className="w-1.5 h-1.5 rounded-full bg-purple-400 shrink-0" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}

      <AssetLibraryModal open={assetsOpen} onClose={() => setAssetsOpen(false)} />
      <BackupModal open={backupOpen} onClose={() => setBackupOpen(false)} />
      <UpdateModal
        open={updateOpen}
        onClose={() => setUpdateOpen(false)}
        initialShowReleases={updateShowsReleases}
      />
      <QuestDeployModal open={questOpen} onClose={() => setQuestOpen(false)} />
      <ThemeModal open={themeOpen} onClose={() => setThemeOpen(false)} />
    </div>
  );
};
