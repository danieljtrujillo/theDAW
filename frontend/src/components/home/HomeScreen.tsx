import React, { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  ArrowRight,
  Compass,
  Disc,
  FileAudio,
  FlaskConical,
  FolderOpen,
  Grid3x3,
  Hammer,
  Route,
  Rows3,
  Scissors,
  Sparkles,
  Tv2,
  Waves,
  Waypoints,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import { type CenterTab } from '../../state/appUiStore';

/** Startup HOME screen: a full-screen overlay shown once the boot intro has
 *  completed (and on demand from the header menu). One dense card grid that
 *  fits on ONE screen without scrolling at 1366x768 and 1920x1080: a wide MAKE
 *  hero (the primary action) plus a Feature Tour card on the first row, then
 *  one compact card per remaining workspace and a Quick Actions card (open
 *  project / import audio / startup preference). Sits at z-60 (same overlay
 *  tier as the shell's modals, below the z-200 boot screen), so an auto-open
 *  during boot stays hidden until the intro lifts.
 *
 *  Sizing: the overlay is a size container, and every row/gap/type size is a
 *  clamp() over container-height units (cqh), so the grid scales with the
 *  window instead of using fixed heights. Container units are used rather than
 *  vh because the shell renders under a CSS `zoom` (0.85–1.1), which makes vh
 *  disagree with the overlay's real layout height. */

export interface HomeScreenProps {
  /** Version string rendered verbatim in the chip next to the wordmark. */
  appVersion?: string;
  showAtStartup: boolean;
  onToggleShowAtStartup: (show: boolean) => void;
  /** Switch the shell to a workspace tab; the overlay dismisses after. */
  onNavigate: (tab: CenterTab) => void;
  onOpenProject: () => void;
  /** Optional — the Import Audio action is hidden when not provided. */
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

interface HomeTab {
  id: CenterTab;
  label: string;
  /** One short benefit line (kept under ~40 chars so it stays on 1–2 lines). */
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Full class literals so Tailwind can see every class. */
  accent: { borderL: string; hoverBorderL: string; icon: string };
}

/** Mirrors the center-bar tab metadata (CenterTabBar.tsx keeps its TABS array
 *  module-private). Order matches the tab bar. MAKE is pulled out as the hero. */
const HOME_TABS: HomeTab[] = [
  {
    id: 'make',
    label: 'Make',
    desc: 'Describe a sound. Get audio in seconds.',
    icon: Sparkles,
    accent: { borderL: 'border-l-purple-500/60', hoverBorderL: 'hover:border-l-purple-400', icon: 'text-purple-300' },
  },
  {
    id: 'edit',
    label: 'Edit',
    desc: 'Arrange clips, add effects, export',
    icon: Scissors,
    accent: { borderL: 'border-l-emerald-500/50', hoverBorderL: 'hover:border-l-emerald-400/90', icon: 'text-emerald-300' },
  },
  {
    id: 'mix',
    label: 'Mix',
    desc: 'Effect rack, processing and mastering',
    icon: Zap,
    accent: { borderL: 'border-l-orange-500/50', hoverBorderL: 'hover:border-l-orange-400/90', icon: 'text-orange-300' },
  },
  {
    id: 'session',
    label: 'Perform',
    desc: 'Launch scenes and clips live',
    icon: Rows3,
    accent: { borderL: 'border-l-sky-500/50', hoverBorderL: 'hover:border-l-sky-400/90', icon: 'text-sky-300' },
  },
  {
    id: 'dj',
    label: 'DJ',
    desc: 'Two decks, stems, cue and automix',
    icon: Disc,
    accent: { borderL: 'border-l-pink-500/50', hoverBorderL: 'hover:border-l-pink-400/90', icon: 'text-pink-300' },
  },
  {
    id: 'vj',
    label: 'VJ',
    desc: 'Live visuals for the show',
    icon: Tv2,
    accent: { borderL: 'border-l-fuchsia-500/50', hoverBorderL: 'hover:border-l-fuchsia-400/90', icon: 'text-fuchsia-300' },
  },
  {
    id: 'sway',
    label: 'Sway',
    desc: 'Gesture control with the Audima Sway',
    icon: Waves,
    accent: { borderL: 'border-l-fuchsia-500/50', hoverBorderL: 'hover:border-l-fuchsia-400/90', icon: 'text-fuchsia-300' },
  },
  {
    id: 'foundry',
    label: 'Foundry',
    desc: 'Design and export plugin interfaces',
    icon: Hammer,
    accent: { borderL: 'border-l-amber-500/50', hoverBorderL: 'hover:border-l-amber-400/90', icon: 'text-amber-300' },
  },
  {
    id: 'underfit',
    label: 'Underfit',
    desc: 'Train a model on your own audio',
    icon: FlaskConical,
    accent: { borderL: 'border-l-sky-500/50', hoverBorderL: 'hover:border-l-sky-400/90', icon: 'text-sky-300' },
  },
  {
    id: 'nodefi',
    label: 'NodeFI',
    desc: 'NodeF.I. — wire node graphs: AI pipelines offline, stems + rack FX live',
    icon: Waypoints,
    accent: { borderL: 'border-l-teal-500/50', hoverBorderL: 'hover:border-l-teal-400/90', icon: 'text-teal-300' },
  },
  {
    id: 'loom',
    label: 'Loom',
    desc: 'Sequence shards of your own songs — beat-matched, in key, on one clock',
    icon: Grid3x3,
    accent: { borderL: 'border-l-amber-500/50', hoverBorderL: 'hover:border-l-amber-400/90', icon: 'text-amber-300' },
  },
  {
    id: 'learn',
    label: 'Learn',
    desc: 'Guides, docs and the assistant',
    icon: Workflow,
    accent: { borderL: 'border-l-rose-500/50', hoverBorderL: 'hover:border-l-rose-400/90', icon: 'text-rose-300' },
  },
  {
    id: 'tour',
    label: 'Tour',
    desc: 'Find venues and plan the drive',
    icon: Route,
    accent: { borderL: 'border-l-lime-500/50', hoverBorderL: 'hover:border-l-lime-400/90', icon: 'text-lime-300' },
  },
];

const HERO = HOME_TABS[0];
const SECONDARY = HOME_TABS.slice(1);

const CARD_BASE = [
  'group relative flex text-left rounded-lg overflow-hidden',
  'bg-[#0c0a14] border border-white/5 border-l-2',
  'transition-colors hover:bg-white/3 hover:border-white/15',
  'outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
].join(' ');

/** First-row height (hero + tour card) and secondary-row height, as clamps over
 *  the overlay's height so three secondary rows + the hero row always fit. */
const ROW_HERO = 'min-h-[clamp(96px,16cqh,180px)]';
const ROW_CARD = 'min-h-[clamp(64px,12cqh,132px)]';
/** Secondary-card type scales with the overlay too, so 1080p is not left with 10px labels. */
const CARD_LABEL = 'text-[clamp(11px,1.5cqh,15px)] font-black uppercase tracking-widest text-zinc-100';
const CARD_DESC = 'text-[clamp(10px,1.3cqh,13px)] font-mono leading-snug text-zinc-400';
const CARD_ICON = 'w-[clamp(16px,2.2cqh,22px)] h-[clamp(16px,2.2cqh,22px)] shrink-0';

const QUICK_ACTION_CLASSES = [
  'flex items-center gap-2 rounded px-1.5 py-1 text-left',
  'text-[10px] font-black uppercase tracking-widest text-zinc-400',
  'transition-colors hover:text-zinc-100 hover:bg-white/5',
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
  const heroRef = useRef<HTMLButtonElement | null>(null);

  // Escape dismisses, matching the shell's popover/modal conventions.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Land keyboard focus on the primary action so Enter opens MAKE.
  useEffect(() => {
    heroRef.current?.focus({ preventScroll: true });
  }, []);

  const go = (tab: CenterTab) => {
    onNavigate(tab);
    onClose();
  };

  const HeroIcon = HERO.icon;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="home-title"
      className="fixed inset-0 z-60 bg-[#0a080f] text-[#f5f3ff] @container-size"
    >
      {/* Subtle radial purple glow behind the content column. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_820px_520px_at_50%_28%,rgba(124,58,237,0.14),transparent_70%)]"
      />

      {/* One screen: the column is centred in the overlay and every row is a
          clamp over the overlay height, so nothing scrolls at 1366x768 or
          1920x1080. overflow-y-auto stays only as a safety net for tiny windows. */}
      <div className="relative h-full w-full overflow-y-auto">
        <div className="min-h-full flex flex-col items-center justify-center px-6 py-[clamp(14px,3cqh,40px)]">
          <div className="w-[min(1280px,94cqw)] flex flex-col gap-[clamp(10px,2cqh,26px)]">
            {/* Top row: wordmark + version chip + close */}
            <div className="flex items-center gap-3">
              <span className="text-[13px] font-black tracking-[0.18em] text-zinc-100">theDAW</span>
              {appVersion && (
                <span className="px-1.5 py-0.5 rounded border border-purple-500/30 bg-purple-500/10 text-[8px] font-mono uppercase tracking-widest text-purple-300">
                  {appVersion}
                </span>
              )}
              <button
                type="button"
                aria-label="Close home screen"
                title="Close (Esc)"
                onClick={onClose}
                className="ml-auto p-1.5 rounded border border-white/5 text-zinc-500 transition-colors hover:text-zinc-200 hover:bg-white/3 outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>

            {/* Heading */}
            <div className="flex flex-col gap-0.5">
              <h1 id="home-title" className="text-[clamp(17px,2.6cqh,26px)] font-black tracking-wide text-zinc-100">
                Make something new.
              </h1>
              <p className="text-[clamp(10px,1.4cqh,13px)] font-mono text-zinc-500">
                Pick a workspace to begin. New here? Take the one-minute tour.
              </p>
            </div>

            {/* Card grid: row 1 = MAKE hero (primary action) + Feature Tour;
                rows 2–4 = the remaining workspaces + Quick Actions. */}
            <div className="grid grid-cols-3 xl:grid-cols-4 gap-[clamp(8px,1.3cqh,14px)]">
              <button
                ref={heroRef}
                type="button"
                aria-label="Open the Make workspace"
                onClick={() => go(HERO.id)}
                className={[
                  CARD_BASE,
                  ROW_HERO,
                  'col-span-2 xl:col-span-3 flex-row items-center gap-[clamp(12px,2cqh,24px)] p-[clamp(12px,1.8cqh,22px)]',
                  'bg-linear-to-r from-purple-500/12 via-[#0c0a14] to-[#0c0a14]',
                  HERO.accent.borderL,
                  HERO.accent.hoverBorderL,
                ].join(' ')}
              >
                <span className="grid shrink-0 place-items-center rounded-xl border border-purple-400/30 bg-purple-500/15 p-[clamp(8px,1.3cqh,14px)]">
                  <HeroIcon className={`w-[clamp(22px,3.4cqh,36px)] h-[clamp(22px,3.4cqh,36px)] ${HERO.accent.icon}`} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[clamp(15px,2.4cqh,24px)] font-black uppercase tracking-widest text-zinc-50">
                    {HERO.label}
                  </span>
                  <span className="text-[clamp(11px,1.5cqh,14px)] font-mono leading-snug text-zinc-400">
                    {HERO.desc} Type a prompt, press CREATE — the result lands in your library.
                  </span>
                </span>
                <span className="hidden sm:inline-flex shrink-0 items-center gap-1 rounded border border-purple-400/40 bg-purple-500/20 px-2.5 py-1.5 text-[10px] font-black uppercase tracking-widest text-purple-50 transition-colors group-hover:bg-purple-500/35">
                  Open Make
                  <ArrowRight className="w-3 h-3" aria-hidden="true" />
                </span>
              </button>

              <button
                type="button"
                aria-label="Start the feature tour"
                onClick={() => {
                  onStartTour();
                  onClose();
                }}
                className={[
                  CARD_BASE,
                  ROW_HERO,
                  'flex-col justify-between gap-2 p-[clamp(10px,1.6cqh,20px)] border-l-amber-500/50 hover:border-l-amber-400/90',
                ].join(' ')}
              >
                <span className="flex items-center gap-2">
                  <Compass className={`${CARD_ICON} text-amber-300`} aria-hidden="true" />
                  <span className={CARD_LABEL}>Feature tour</span>
                </span>
                <span className={CARD_DESC}>New here? A one-minute walk through the app.</span>
                <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-amber-200/90">
                  Start
                  <ArrowRight className="w-3 h-3" aria-hidden="true" />
                </span>
              </button>

              {SECONDARY.map((t) => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    type="button"
                    aria-label={`Open the ${t.label} workspace`}
                    onClick={() => go(t.id)}
                    className={[
                      CARD_BASE,
                      ROW_CARD,
                      'flex-col gap-1.5 p-[clamp(10px,1.6cqh,20px)]',
                      t.accent.borderL,
                      t.accent.hoverBorderL,
                    ].join(' ')}
                  >
                    <span className="flex items-center gap-2">
                      <Icon className={`${CARD_ICON} ${t.accent.icon}`} />
                      <span className={CARD_LABEL}>{t.label}</span>
                    </span>
                    <span className={`${CARD_DESC} line-clamp-2`}>{t.desc}</span>
                  </button>
                );
              })}

              {/* Quick actions — fills the last grid slot. */}
              <div
                className={[
                  'flex flex-col gap-0.5 rounded-lg p-[clamp(8px,1.2cqh,14px)]',
                  ROW_CARD,
                  'bg-[#0c0a14]/70 border border-dashed border-white/10',
                ].join(' ')}
              >
                <span className="px-1.5 text-[10px] font-mono uppercase tracking-widest text-zinc-600">Quick actions</span>
                <button
                  type="button"
                  aria-label="Open a project file"
                  onClick={() => {
                    onOpenProject();
                    onClose();
                  }}
                  className={QUICK_ACTION_CLASSES}
                >
                  <FolderOpen className="w-3.5 h-3.5 shrink-0 text-sky-300" aria-hidden="true" />
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
                    className={QUICK_ACTION_CLASSES}
                  >
                    <FileAudio className="w-3.5 h-3.5 shrink-0 text-emerald-300" aria-hidden="true" />
                    <span>Import Audio</span>
                  </button>
                )}
                <div className="mt-auto flex items-center gap-1.5 px-1.5 pb-0.5">
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
      </div>
    </div>
  );
};
