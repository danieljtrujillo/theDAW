import React, { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  Compass,
  Disc,
  FileAudio,
  FlaskConical,
  FolderOpen,
  Hammer,
  Route,
  Rows3,
  Scissors,
  Sparkles,
  Tv2,
  Waypoints,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import { type CenterTab } from '../../state/appUiStore';

/** Startup HOME screen: a full-screen overlay shown once the boot intro has
 *  completed (and on demand from the header menu). One card per center tab
 *  plus a slim task row (open project / import audio / feature tour). Sits at
 *  z-60 (same overlay tier as the shell's modals, below the z-200 boot
 *  screen), so an auto-open during boot stays hidden until the intro lifts. */

export interface HomeScreenProps {
  /** Version string rendered verbatim in the chip next to the wordmark. */
  appVersion?: string;
  showAtStartup: boolean;
  onToggleShowAtStartup: (show: boolean) => void;
  /** Switch the shell to a workspace tab; the overlay dismisses after. */
  onNavigate: (tab: CenterTab) => void;
  onOpenProject: () => void;
  /** Optional — the Import Audio card is hidden when not provided. */
  onImportAudio?: () => void;
  onStartTour: () => void;
  onClose: () => void;
}

/** Open/persisted-preference state so the shell, App's boot handoff and the
 *  header menu can all drive the overlay without threading local state.
 *  Only `showAtStartup` persists; `open` always resets per app open. */
interface HomeScreenState {
  open: boolean;
  showAtStartup: boolean;
  setOpen: (open: boolean) => void;
  setShowAtStartup: (show: boolean) => void;
}

export const useHomeScreenStore = create<HomeScreenState>()(
  persist(
    (set) => ({
      open: false,
      showAtStartup: true,
      setOpen: (open) => set({ open }),
      setShowAtStartup: (showAtStartup) => set({ showAtStartup }),
    }),
    {
      name: 'thedaw-home-screen-v1',
      partialize: (s) => ({ showAtStartup: s.showAtStartup }),
    },
  ),
);

/** Mirrors the center-bar tab metadata (CenterTabBar.tsx keeps its TABS array
 *  module-private, so the id/label/desc/icon/accent set is restated here).
 *  Accent classes are full literals so Tailwind can see every class. */
const HOME_TABS: Array<{
  id: CenterTab;
  label: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: { borderL: string; hoverBorderL: string; icon: string };
}> = [
  {
    id: 'make',
    label: 'Make',
    desc: 'Generate audio from a text prompt with the AI models',
    icon: Sparkles,
    accent: {
      borderL: 'border-l-purple-500/50',
      hoverBorderL: 'hover:border-l-purple-400/90',
      icon: 'text-purple-300',
    },
  },
  {
    id: 'edit',
    label: 'Edit',
    desc: 'Arrange clips on a timeline, add effects and automation, export',
    icon: Scissors,
    accent: {
      borderL: 'border-l-emerald-500/50',
      hoverBorderL: 'hover:border-l-emerald-400/90',
      icon: 'text-emerald-300',
    },
  },
  {
    id: 'mix',
    label: 'Mix',
    desc: 'Process and master audio with the effect and module rack',
    icon: Zap,
    accent: {
      borderL: 'border-l-orange-500/50',
      hoverBorderL: 'hover:border-l-orange-400/90',
      icon: 'text-orange-300',
    },
  },
  {
    id: 'session',
    label: 'Perform',
    desc: 'Import a project and perform its scene/clip grid live',
    icon: Rows3,
    accent: {
      borderL: 'border-l-sky-500/50',
      hoverBorderL: 'hover:border-l-sky-400/90',
      icon: 'text-sky-300',
    },
  },
  {
    id: 'dj',
    label: 'DJ',
    desc: 'Two-deck DJ console: mix, cue, scratch, stems and automix',
    icon: Disc,
    accent: {
      borderL: 'border-l-pink-500/50',
      hoverBorderL: 'hover:border-l-pink-400/90',
      icon: 'text-pink-300',
    },
  },
  {
    id: 'vj',
    label: 'VJ',
    desc: 'Live visuals engine: sources, effects and output for performance',
    icon: Tv2,
    accent: {
      borderL: 'border-l-fuchsia-500/50',
      hoverBorderL: 'hover:border-l-fuchsia-400/90',
      icon: 'text-fuchsia-300',
    },
  },
  {
    id: 'foundry',
    label: 'Foundry',
    desc: 'Design and export custom VST / plugin interfaces on an infinite canvas',
    icon: Hammer,
    accent: {
      borderL: 'border-l-amber-500/50',
      hoverBorderL: 'hover:border-l-amber-400/90',
      icon: 'text-amber-300',
    },
  },
  {
    id: 'underfit',
    label: 'Underfit',
    desc: 'Train LoRA finetunes with the Underfit dashboard',
    icon: FlaskConical,
    accent: {
      borderL: 'border-l-sky-500/50',
      hoverBorderL: 'hover:border-l-sky-400/90',
      icon: 'text-sky-300',
    },
  },
  {
    id: 'audimate',
    label: 'Audimate',
    desc: 'Build generation pipelines as a wired node graph, then run them',
    icon: Waypoints,
    accent: {
      borderL: 'border-l-teal-500/50',
      hoverBorderL: 'hover:border-l-teal-400/90',
      icon: 'text-teal-300',
    },
  },
  {
    id: 'learn',
    label: 'Learn',
    desc: 'Guides, docs and the in-app assistant',
    icon: Workflow,
    accent: {
      borderL: 'border-l-rose-500/50',
      hoverBorderL: 'hover:border-l-rose-400/90',
      icon: 'text-rose-300',
    },
  },
  {
    id: 'tour',
    label: 'Tour',
    desc: 'Find venues and promoters by region, plan multi-stop tour routes',
    icon: Route,
    accent: {
      borderL: 'border-l-lime-500/50',
      hoverBorderL: 'hover:border-l-lime-400/90',
      icon: 'text-lime-300',
    },
  },
];

const TASK_BUTTON_CLASSES = [
  'flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded',
  'bg-[#0c0a14] border border-white/5',
  'text-[10px] font-black uppercase tracking-widest text-zinc-400',
  'transition-colors hover:text-zinc-100 hover:bg-white/3 hover:border-white/15',
  'outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
].join(' ');

export const HomeScreen: React.FC<HomeScreenProps> = ({
  appVersion,
  showAtStartup,
  onToggleShowAtStartup,
  onNavigate,
  onOpenProject,
  onImportAudio,
  onStartTour,
  onClose,
}) => {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Escape dismisses, matching the shell's popover/modal conventions.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Land keyboard focus inside the dialog on open.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Home"
      className="fixed inset-0 z-60 bg-[#0a080f] text-[#f5f3ff]"
    >
      {/* Subtle radial purple glow behind the content column. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_820px_520px_at_50%_28%,rgba(124,58,237,0.14),transparent_70%)]"
      />

      <div className="relative h-full overflow-y-auto">
        <div className="min-h-full flex flex-col items-center justify-center px-6 py-10">
          <div className="w-[min(1080px,94vw)] flex flex-col gap-5">
            {/* Top row: wordmark + version chip + close */}
            <div className="flex items-center gap-3">
              <span className="text-[13px] font-black tracking-[0.18em] text-zinc-100">
                theDAW
              </span>
              {appVersion && (
                <span className="px-1.5 py-0.5 rounded border border-purple-500/30 bg-purple-500/10 text-[8px] font-mono uppercase tracking-widest text-purple-300">
                  {appVersion}
                </span>
              )}
              <button
                ref={closeRef}
                type="button"
                aria-label="Close home screen"
                onClick={onClose}
                className="ml-auto p-1.5 rounded border border-white/5 text-zinc-500 transition-colors hover:text-zinc-200 hover:bg-white/3 outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Hero line */}
            <p className="text-base font-semibold tracking-wide text-zinc-200">
              Make something new.
            </p>

            {/* Workspace cards: one per center tab. Larger tiles (fewer per row,
                bigger icon + type) so the labels/descriptions read clearly and
                the tiles are not mostly empty space. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {HOME_TABS.map((t) => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    type="button"
                    aria-label={`Open the ${t.label} workspace`}
                    onClick={() => {
                      onNavigate(t.id);
                      onClose();
                    }}
                    className={[
                      'flex flex-col items-start gap-2.5 p-5 rounded-lg text-left',
                      'bg-[#0c0a14] border border-white/5 border-l-2',
                      t.accent.borderL,
                      'transition-all hover:-translate-y-0.5 hover:bg-white/3 hover:border-white/15',
                      t.accent.hoverBorderL,
                      'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
                      'outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
                    ].join(' ')}
                  >
                    <Icon className={`w-8 h-8 ${t.accent.icon}`} />
                    <span className="text-base font-black uppercase tracking-widest text-zinc-100">
                      {t.label}
                    </span>
                    <span className="text-sm font-mono leading-relaxed text-zinc-400">
                      {t.desc}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Slim task row */}
            <div className="flex items-stretch gap-2">
              <button
                type="button"
                aria-label="Open a project file"
                onClick={() => {
                  onOpenProject();
                  onClose();
                }}
                className={TASK_BUTTON_CLASSES}
              >
                <FolderOpen className="w-3.5 h-3.5 shrink-0 text-sky-300" />
                <span>Open Project</span>
              </button>
              {onImportAudio && (
                <button
                  type="button"
                  aria-label="Import audio"
                  onClick={() => {
                    onImportAudio();
                    onClose();
                  }}
                  className={TASK_BUTTON_CLASSES}
                >
                  <FileAudio className="w-3.5 h-3.5 shrink-0 text-emerald-300" />
                  <span>Import Audio</span>
                </button>
              )}
              <button
                type="button"
                aria-label="Start the feature tour"
                onClick={() => {
                  onStartTour();
                  onClose();
                }}
                className={TASK_BUTTON_CLASSES}
              >
                <Compass className="w-3.5 h-3.5 shrink-0 text-purple-300" />
                <span>Feature Tour</span>
              </button>
            </div>

            {/* Footer: startup preference */}
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="home-show-at-startup"
                name="home-show-at-startup"
                checked={showAtStartup}
                onChange={(e) => onToggleShowAtStartup(e.target.checked)}
                className="w-3 h-3 accent-purple-500"
              />
              <label
                htmlFor="home-show-at-startup"
                className="text-[9px] font-mono uppercase tracking-widest text-zinc-500 select-none cursor-pointer"
              >
                Show at startup
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
