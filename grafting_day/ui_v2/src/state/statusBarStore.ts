import { create } from 'zustand';

interface StatusBarStoreState {
  text: string;
  healthy: boolean | null;
  setText: (text: string) => void;
  refreshHealth: () => Promise<void>;
}

export const useStatusBarStore = create<StatusBarStoreState>()((set) => ({
  text: 'READY',
  healthy: null,

  setText: (text) => {
    set({ text });
  },

  refreshHealth: async () => {
    try {
      const response = await fetch('/api/health');
      if (!response.ok) {
        set({ healthy: false, text: `HEALTH FAIL (${response.status})` });
        return;
      }

      const payload = (await response.json()) as { status?: string; model_loaded?: boolean };
      const healthy = payload.status === 'ok';
      set({
        healthy,
        text: healthy
          ? payload.model_loaded
            ? 'API HEALTHY // MODEL LOADED'
            : 'API HEALTHY // MODEL LOADING'
          : 'API UNHEALTHY',
      });
    } catch {
      set({ healthy: false, text: 'API UNREACHABLE' });
    }
  },
}));
