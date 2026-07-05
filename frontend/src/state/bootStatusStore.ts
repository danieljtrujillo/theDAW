import { create } from 'zustand';

// First-run bootstrap status surfaced on the loading screen. The packaged
// Electron main streams `uv sync` / backend-spawn progress and errors to
// window.setStatus / window.addLog (electron-ui/main/index.ts); those globals
// (defined in main.tsx) feed this store so a slow or failed first-run setup is
// VISIBLE instead of looking like a silent hang on the splash.

interface BootStatusState {
  status: string;
  logs: string[];
  error: string | null;
  setStatus: (s: string) => void;
  pushLog: (line: string) => void;
  setError: (e: string) => void;
}

const MAX_LOGS = 8;

export const useBootStatusStore = create<BootStatusState>()((set) => ({
  status: '',
  logs: [],
  error: null,
  setStatus: (s) => set({ status: s }),
  pushLog: (line) =>
    set((st) => {
      const logs = [...st.logs, line];
      if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
      return { logs };
    }),
  setError: (e) => set({ error: e }),
}));
