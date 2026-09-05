import { Compass } from 'lucide-react';
import { useOnboardingStore } from '../../onboarding/onboardingStore';
/**
 * Settings modal — one screen, no scrolling at 1920x1080.
 *
 * The body is a CSS multi-column layout (1 / 2 / 3 columns at <lg / lg / 2xl)
 * so the browser balances the sections' heights across columns; each section
 * is `break-inside-avoid` so it never splits. Reading order: Models,
 * Autoprocesses, Layout, Modules, Storage. At 1366x768 it degrades to two
 * balanced columns (and the body scrolls if it must). Every section lives in
 * ./settings/*; this file is the shell: backdrop, header (launch mode, artist,
 * restart, shutdown, close), the column body, and the sponsor footer.
 */
import React, { useEffect, useState } from 'react';
import { ExternalLink, Globe, Heart, Monitor, Settings, UserCircle, X } from 'lucide-react';
import { useFeatureToggleStore } from '../../state/featureToggleStore';
import { ModelsSection } from './settings/ModelsSection';
import { StorageSection } from './settings/StorageSection';
import { AutoprocessSection } from './settings/AutoprocessSection';
import { ModulesSection } from './settings/ModulesSection';
import { LayoutSection } from './settings/LayoutSection';
import { RestartServerButton, ShutdownServerButton } from './settings/ServerButtons';

export const SettingsModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const featureSettings = useFeatureToggleStore((s) => s.settings);
  const refreshFeatures = useFeatureToggleStore((s) => s.refresh);
  const patchFeatures = useFeatureToggleStore((s) => s.patch);
  const launchMode = featureSettings.app?.launch_mode ?? 'web';

  useEffect(() => {
    if (!open) return;
    void refreshFeatures();
  }, [open, refreshFeatures]);

  // Artist/composer name (appended to songs + stamped on every sheet). Mirrored
  // locally so typing doesn't PATCH per keystroke; committed on blur / Enter.
  const artist = featureSettings.notation?.artist ?? 'GANTASMO';
  const [showName, setShowName] = useState(false);
  const [artistDraft, setArtistDraft] = useState('');
  useEffect(() => { setArtistDraft(featureSettings.notation?.artist ?? 'GANTASMO'); }, [featureSettings.notation?.artist]);
  const commitArtist = () => {
    const v = artistDraft.trim() || 'GANTASMO';
    if (v !== (featureSettings.notation?.artist ?? '')) void patchFeatures({ notation: { artist: v } });
  };

  // Icon-button styling shared by the header's launch-mode + profile toggles.
  const iconBtn = (active: boolean) =>
    `p-1 rounded border transition-colors ${active
      ? 'border-purple-400/60 bg-purple-500/20 text-purple-200'
      : 'border-transparent text-zinc-400 hover:text-white hover:bg-white/5'}`;

  if (!open) return null;

  return (
    // Bottom inset = the PlayerFooter (fixed, UNzoomed, z-50 and later in the
    // DOM, so it paints over this z-50 overlay): without it a tall modal's last
    // rows sat under the footer. Sizes are % of this inset box rather than vh —
    // inside the zoomed shell vh is multiplied by the zoom (94vh = 103vh at 1.1).
    <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-center" style={{ bottom: 'calc(5rem / var(--layout-zoom, 1))' }}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="relative bg-[#0c0a14] border border-purple-500/30 rounded-lg w-[min(1720px,96%)] max-h-[96%] flex flex-col shadow-2xl"
      >
        {/* Header — title + launch-mode + profile + restart/shutdown + close,
            all icon-only (hover tooltips name each one). */}
        <div className="relative flex items-center gap-2 px-3 py-1.5 border-b border-white/5 shrink-0">
          <Settings className="w-3.5 h-3.5 text-purple-400 shrink-0" />
          <span id="settings-title" className="text-xs font-black uppercase tracking-widest text-purple-300 shrink-0">Settings</span>
          <div className="flex items-center gap-1 ml-auto">
            {/* Launch mode — Web vs Desktop next launch (run theDAW.bat). */}
            <button
              type="button"
              onClick={() => void patchFeatures({ app: { launch_mode: 'web' } })}
              title="Next launch: open in your browser (web)"
              aria-label="Web launch mode"
              aria-pressed={launchMode === 'web'}
              className={iconBtn(launchMode === 'web')}
            >
              <Globe className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void patchFeatures({ app: { launch_mode: 'desktop' } })}
              title="Next launch: open the desktop app"
              aria-label="Desktop launch mode"
              aria-pressed={launchMode === 'desktop'}
              className={iconBtn(launchMode === 'desktop')}
            >
              <Monitor className="w-3.5 h-3.5" />
            </button>
            <span className="w-px h-4 bg-white/10 mx-0.5" />
            {/* Profile — artist name appended to songs/scores. */}
            <button
              type="button"
              onClick={() => setShowName((v) => !v)}
              title={`Artist name: ${artist}`}
              aria-label="Set artist name"
              aria-expanded={showName}
              aria-controls="settings-artist-popover"
              className={iconBtn(showName)}
            >
              <UserCircle className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => { onClose(); useOnboardingStore.getState().start(); }}
              title="Replay the feature tour"
              aria-label="Replay the feature tour"
              className={iconBtn(false)}
            >
              <Compass className="w-3.5 h-3.5" />
            </button>
            <RestartServerButton compact iconOnly />
            <ShutdownServerButton compact iconOnly />
            <button type="button" onClick={onClose} aria-label="Close settings" className="p-1 text-zinc-400 hover:text-white transition-colors rounded hover:bg-white/5">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Artist-name popover (toggled by the profile icon). */}
          <div
            id="settings-artist-popover"
            hidden={!showName}
            className="absolute right-3 top-full mt-1 z-10 flex items-center gap-2 rounded-md border border-purple-500/30 bg-[#0c0a14] p-2 shadow-xl"
          >
            <label htmlFor="settings-artist" className="text-[11px] font-mono uppercase tracking-widest text-zinc-400 shrink-0">Artist</label>
            <input
              id="settings-artist"
              name="settings-artist"
              type="text"
              value={artistDraft}
              onChange={(e) => setArtistDraft(e.target.value)}
              onBlur={commitArtist}
              onKeyDown={(e) => { if (e.key === 'Enter') { commitArtist(); setShowName(false); } }}
              placeholder="GANTASMO"
              className="w-44 rounded border border-white/10 bg-black/40 px-1.5 py-1 text-xs text-zinc-100 outline-none focus:border-purple-400/50"
            />
          </div>
        </div>

        {/* Body — balanced columns; sections never split across a column. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2">
          <div className="columns-1 lg:columns-2 2xl:columns-3 gap-3">
            <div className="break-inside-avoid mb-3"><ModelsSection /></div>
            <div className="break-inside-avoid mb-3"><AutoprocessSection /></div>
            <div className="break-inside-avoid mb-3"><LayoutSection /></div>
            <div className="break-inside-avoid mb-3"><ModulesSection /></div>
            <div className="break-inside-avoid mb-3"><StorageSection /></div>
          </div>
        </div>

        {/* Pinned Support — one compact row, always at the bottom */}
        <div className="shrink-0 border-t border-purple-500/20 bg-[#0a080f] px-3 py-1.5 flex items-center justify-center gap-3">
          <a
            href="https://github.com/sponsors/gantasmo"
            target="_blank"
            rel="noopener noreferrer"
            title="theDAW is independent and self-funded. A sponsorship keeps development going (food, coffee, and compute) and flows straight back into the software."
            className="group inline-flex items-center gap-2 rounded-md border border-purple-400/50 bg-purple-500/20 px-4 py-1 text-[11px] font-black uppercase tracking-widest text-purple-100 shadow-lg shadow-purple-900/30 hover:bg-purple-500/30 hover:border-purple-300/70 hover:text-white transition-colors"
          >
            <Heart className="w-3.5 h-3.5 group-hover:scale-110 transition-transform" />
            Sponsor theDAW
            <ExternalLink className="w-3 h-3 opacity-70" />
          </a>
          <span className="text-[11px] font-mono uppercase tracking-widest text-zinc-500">independent &amp; self-funded</span>
        </div>
      </div>
    </div>
  );
};
