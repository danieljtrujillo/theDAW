import React, { useEffect, useRef, useState } from 'react';
import {
  Archive,
  BookOpen,
  Compass,
  FilePlus2,
  FolderInput,
  FolderOpen,
  Headset,
  History,
  Home,
  LayoutGrid,
  Menu,
  Palette,
  RefreshCw,
  Save,
  Settings,
} from 'lucide-react';
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
  icon: React.ComponentType<{ className?: string }>;
  iconCls: string;
  onSelect: () => void;
  /** Row shows an accent dot when the underlying toggle is on (Edit Layout). */
  active?: boolean;
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
        { id: 'home-screen', label: 'Home Screen', icon: Home, iconCls: 'text-amber-300', onSelect: onOpenHome },
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

  const selectItem = (item: MenuAction) => {
    setOpen(false);
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
        aria-controls="app-hamburger-menu"
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
                    className={`${ITEM_CLS} ${item.active ? 'bg-purple-500/10 text-purple-200' : ''}`}
                  >
                    <Icon className={`w-3.5 h-3.5 shrink-0 ${item.iconCls}`} />
                    <span className="flex-1 min-w-0 truncate">{item.label}</span>
                    {item.active && <span className="w-1.5 h-1.5 rounded-full bg-purple-400 shrink-0" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}

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
