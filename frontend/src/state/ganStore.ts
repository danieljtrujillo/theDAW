import { create } from 'zustand';
import { ganApi, type GanPluginSummary } from '../lib/ganClient';
import { logError, logInfo } from './logStore';
import { useStatusBarStore } from './statusBarStore';

// Installed .gan plugin library + the one currently open in the MIX effect stage.
// A .gan loaded here renders as an iframe (GanPluginStage) in the same footprint
// as a Studio Module; The Owl is a special native case, separate from this list.
interface GanState {
  plugins: GanPluginSummary[];
  busy: boolean;
  error: string | null;
  activeId: string | null;
  activeUrl: string | null;
  activeName: string | null;
  refresh: () => Promise<void>;
  openPath: (path: string) => Promise<void>;
  openById: (id: string) => Promise<void>;
  importOwl: (projectPath: string) => Promise<void>;
  /** Ensure the bundled "Ares" control surface is installed (package it on first
   *  run), then refresh the list so it shows as a first-class Studio entry. */
  ensureAres: () => Promise<void>;
  close: () => void;
}

// In-flight ensureAres promise. package-ares rewrites the installed Ares
// runtime files in place, so two concurrent ensures (or an openById racing
// one) could serve half-written files to the stage iframe. All concurrent
// callers await this single run; it resets when the run settles, so later
// calls still repackage and pick up bundled-project edits.
let ensureAresInflight: Promise<void> | null = null;

export const useGanStore = create<GanState>()((set, get) => ({
  plugins: [],
  busy: false,
  error: null,
  activeId: null,
  activeUrl: null,
  activeName: null,

  refresh: async () => {
    try {
      const res = await ganApi.list();
      set({ plugins: res.plugins });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'plugin list failed';
      set({ error: msg });
      logError('plugin', msg);
    }
  },

  openPath: async (path) => {
    set({ busy: true, error: null });
    try {
      const res = await ganApi.open(path);
      const id = String(res.manifest.id ?? '');
      set({
        busy: false,
        activeId: id || path,
        activeUrl: res.entry_url,
        activeName: String(res.manifest.name ?? 'plugin'),
      });
      logInfo('plugin', `opened .gan: ${path}`);
      void get().refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'open .gan failed';
      set({ busy: false, error: msg });
      useStatusBarStore.getState().setText(`OPEN .gan FAILED: ${msg}`);
      logError('plugin', msg);
    }
  },

  openById: async (id) => {
    // Instant path: an installed plugin's entry URL is already in the list, so
    // the stage mounts the runtime in the same tick (the backend extracts a
    // runtime lazily on the first asset request anyway). Re-opening Ares after
    // a tab round-trip therefore never waits on a network round trip; the
    // confirming /open call below runs in the background.
    const known = get().plugins.find((p) => p.id === id);
    if (known?.entry_url) {
      set({
        busy: false,
        error: null,
        activeId: id,
        activeUrl: known.entry_url,
        activeName: known.name || 'plugin',
      });
      try {
        const res = await ganApi.openById(id);
        if (get().activeId !== id) return; // the user moved on meanwhile
        const name = String(res.manifest.name ?? known.name ?? 'plugin');
        if (res.entry_url !== known.entry_url || name !== get().activeName) {
          set({ activeUrl: res.entry_url, activeName: name });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'open .gan failed';
        logError('plugin', msg);
        if (get().activeId === id) set({ error: msg });
      }
      return;
    }
    set({ busy: true, error: null });
    try {
      const res = await ganApi.openById(id);
      set({
        busy: false,
        activeId: id,
        activeUrl: res.entry_url,
        activeName: String(res.manifest.name ?? 'plugin'),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'open .gan failed';
      set({ busy: false, error: msg });
      logError('plugin', msg);
    }
  },

  importOwl: async (projectPath) => {
    set({ busy: true, error: null });
    try {
      const res = await ganApi.importOwl(projectPath);
      const id = String(res.manifest.id ?? '');
      set({
        busy: false,
        activeId: id,
        activeUrl: res.entry_url,
        activeName: String(res.manifest.name ?? 'plugin'),
      });
      logInfo('plugin', `imported VST Foundry export -> ${res.gan_path}`);
      void get().refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'import failed';
      set({ busy: false, error: msg });
      useStatusBarStore.getState().setText(`IMPORT FAILED: ${msg}`);
      logError('plugin', msg);
    }
  },

  ensureAres: async () => {
    // Always ask: package-ares compares the bundled source + runtime template
    // against the installed bundle and only rewrites the .gan / runtime when
    // they differ, so edits to the bundled Ares project.json still ship while
    // an unchanged install costs one cheap round trip (and keeps the browser's
    // cached runtime assets valid). Concurrent calls (MixView mounts fire two
    // ensure paths in the same tick) share ONE in-flight run so the runtime is
    // never rewritten by two package-ares requests at once.
    if (ensureAresInflight) return ensureAresInflight;
    ensureAresInflight = (async () => {
      try {
        const r = await ganApi.packageAres();
        // The list only needs refetching when the bundle actually changed (new
        // control ids) or Ares is not in the list yet.
        if (r.rebuilt !== false || !get().plugins.some((p) => p.id === 'ares')) {
          await get().refresh();
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Ares package failed';
        logError('plugin', msg);
      } finally {
        ensureAresInflight = null;
      }
    })();
    return ensureAresInflight;
  },

  close: () => set({ activeId: null, activeUrl: null, activeName: null }),
}));
