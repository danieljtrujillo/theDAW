/**
 * Backend module catalog store.
 *
 * The Settings modal used to fetch `/api/modules/all` every time it opened —
 * which meant opening it during a backend (re)start hit a transient failure
 * and rendered a misleading "No modules found", as if every module had
 * vanished. This store fixes the root cause: the catalog loads ONCE when the
 * backend becomes ready (preloaded from App), retries until it succeeds, and
 * is cached. By the time the user opens Settings the list is already there, so
 * there is nothing to fail.
 */
import { create } from 'zustand';

export interface ModuleConfig {
  name: string;
  label?: string;
  description?: string;
  version?: string;
  enabled: boolean;
  api_prefix?: string;
  _dir?: string;
  _loaded?: boolean;
  [key: string]: unknown;
}

interface ModuleStore {
  modules: ModuleConfig[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** Load (or reload) the catalog, retrying transient failures until success. */
  load: (opts?: { force?: boolean }) => Promise<void>;
  /** Toggle a module enabled flag (persists to its module.json on the backend). */
  setEnabled: (dirName: string, enabled: boolean) => Promise<boolean>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const useModuleStore = create<ModuleStore>((set, get) => ({
  modules: [],
  loaded: false,
  loading: false,
  error: null,

  load: async (opts = {}) => {
    const s = get();
    if (s.loading) return;
    if (s.loaded && !opts.force) return;
    set({ loading: true, error: null });
    // Retry with backoff: the backend may still be binding right after launch.
    let delay = 500;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const res = await fetch('/api/modules/all');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ModuleConfig[];
        if (!Array.isArray(data)) throw new Error('unexpected response shape');
        set({ modules: data, loaded: true, loading: false, error: null });
        return;
      } catch (e) {
        if (attempt === 5) {
          set({ loading: false, error: e instanceof Error ? e.message : String(e) });
          return;
        }
        await sleep(delay);
        delay = Math.min(delay * 2, 4000);
      }
    }
  },

  setEnabled: async (dirName, enabled) => {
    try {
      const res = await fetch(`/api/modules/${dirName}/enabled`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) return false;
      set((state) => ({
        modules: state.modules.map((m) => (m._dir === dirName ? { ...m, enabled } : m)),
      }));
      return true;
    } catch {
      return false;
    }
  },
}));
