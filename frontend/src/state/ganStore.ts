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
  close: () => void;
}

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

  close: () => set({ activeId: null, activeUrl: null, activeName: null }),
}));
