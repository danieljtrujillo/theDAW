/**
 * How every SemanticWave-backed waveform in the app draws itself — one
 * global preference, not per-instance, because "what do all these colors
 * mean, can I turn them off" is a whole-app question, not a per-clip one.
 * Persisted in localStorage under 'thedaw.waveformStyle.v1', same convention
 * as djCuesStore. (Browser-tab and Electron-shell localStorage partitions
 * don't share, unlike device selection which routes through the backend
 * settings store — acceptable here since this is a cosmetic preference, not
 * a functional or safety one.)
 */
import { create } from 'zustand';
import type { WaveformDrawMode } from '../components/audio/djSemanticWaveformAnalysis';

export type { WaveformDrawMode };

export const WAVEFORM_DRAW_MODES: readonly WaveformDrawMode[] = ['semantic', 'plain', 'clipping'];

const STORAGE_KEY = 'thedaw.waveformStyle.v1';

function isMode(v: unknown): v is WaveformDrawMode {
  return v === 'semantic' || v === 'plain' || v === 'clipping';
}

function loadMode(): WaveformDrawMode {
  if (typeof localStorage === 'undefined') return 'semantic';
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isMode(raw) ? raw : 'semantic';
  } catch {
    return 'semantic';
  }
}

function saveMode(mode: WaveformDrawMode): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Storage full/disabled: the mode still holds for this session.
  }
}

interface WaveformStyleState {
  mode: WaveformDrawMode;
  setMode: (mode: WaveformDrawMode) => void;
  /** Cycles semantic -> plain -> clipping -> semantic; what the corner toggle calls. */
  cycleMode: () => void;
}

export const useWaveformStyleStore = create<WaveformStyleState>((set, get) => ({
  mode: loadMode(),
  setMode: (mode) => {
    saveMode(mode);
    set({ mode });
  },
  cycleMode: () => {
    const i = WAVEFORM_DRAW_MODES.indexOf(get().mode);
    const next = WAVEFORM_DRAW_MODES[(i + 1) % WAVEFORM_DRAW_MODES.length];
    saveMode(next);
    set({ mode: next });
  },
}));
