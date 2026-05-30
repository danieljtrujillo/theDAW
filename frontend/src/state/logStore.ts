import { create } from 'zustand';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  id: string;
  ts: number;
  level: LogLevel;
  source: string;
  msg: string;
}

interface LogStoreState {
  entries: LogEntry[];
  append: (level: LogLevel, source: string, msg: string) => void;
  clear: () => void;
}

const MAX_ENTRIES = 500;

let nextId = 0;

export const useLogStore = create<LogStoreState>()((set) => ({
  entries: [],
  append: (level, source, msg) =>
    set((s) => {
      const entry: LogEntry = {
        id: `${Date.now()}-${nextId++}`,
        ts: Date.now(),
        level,
        source,
        msg,
      };
      const next = [...s.entries, entry];
      if (next.length > MAX_ENTRIES) {
        next.splice(0, next.length - MAX_ENTRIES);
      }
      return { entries: next };
    }),
  clear: () => set({ entries: [] }),
}));

export const logInfo = (source: string, msg: string) =>
  useLogStore.getState().append('info', source, msg);
export const logWarn = (source: string, msg: string) =>
  useLogStore.getState().append('warn', source, msg);
export const logError = (source: string, msg: string) =>
  useLogStore.getState().append('error', source, msg);
export const logDebug = (source: string, msg: string) =>
  useLogStore.getState().append('debug', source, msg);

