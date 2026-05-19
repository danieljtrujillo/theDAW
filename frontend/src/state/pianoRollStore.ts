import { create } from 'zustand';

export interface PianoNote {
  id: string;
  /** MIDI note number (0-127). 60 = middle C. */
  note: number;
  /** Step index where the note starts (16th notes from 0). */
  step: number;
  /** Length in steps. */
  length: number;
  velocity: number;
}

interface PianoRollState {
  notes: PianoNote[];
  bpm: number;
  /** Total grid length in 16th-note steps. */
  totalSteps: number;
  /** Lowest and highest MIDI note numbers in view (inclusive). */
  lowestNote: number;
  highestNote: number;
  selectedNoteId: string | null;
  isPlaying: boolean;
  currentStep: number;
  /** If set, the roll is editing an existing editor clip — next "send to editor" updates that clip in place. */
  editingClipId: string | null;

  setBpm: (bpm: number) => void;
  setTotalSteps: (s: number) => void;
  setRange: (lo: number, hi: number) => void;
  addNote: (note: Omit<PianoNote, 'id'>) => string;
  removeNote: (id: string) => void;
  updateNote: (id: string, patch: Partial<PianoNote>) => void;
  setSelectedNote: (id: string | null) => void;
  setPlaying: (playing: boolean) => void;
  setCurrentStep: (s: number) => void;
  replaceAll: (notes: PianoNote[]) => void;
  clear: () => void;
  setEditingClip: (id: string | null) => void;
  loadFromClip: (clipId: string, notes: PianoNote[], bpm: number, totalSteps: number) => void;
}

const uid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `pn-${Math.random().toString(36).slice(2)}-${Date.now()}`;

const seed = (): PianoNote[] => {
  // A short C-major arpeggio across two bars so the grid isn't empty on first load.
  const arr: PianoNote[] = [];
  const pitches = [60, 64, 67, 72, 67, 64, 60, 67]; // C E G C G E C G
  for (let i = 0; i < pitches.length; i += 1) {
    arr.push({ id: uid(), note: pitches[i], step: i * 2, length: 2, velocity: 90 });
  }
  return arr;
};

export const usePianoRollStore = create<PianoRollState>()((set) => ({
  notes: seed(),
  bpm: 120,
  totalSteps: 32, // 2 bars at 16ths
  lowestNote: 48, // C3
  highestNote: 84, // C6
  selectedNoteId: null,
  isPlaying: false,
  currentStep: 0,
  editingClipId: null,

  setBpm: (bpm) => set({ bpm: Math.max(40, Math.min(240, bpm)) }),
  setTotalSteps: (totalSteps) => set({ totalSteps: Math.max(16, Math.min(256, totalSteps)) }),
  setRange: (lo, hi) => set({ lowestNote: Math.max(0, lo), highestNote: Math.min(127, hi) }),

  addNote: (note) => {
    const id = uid();
    set((s) => ({ notes: [...s.notes, { ...note, id }], selectedNoteId: id }));
    return id;
  },

  removeNote: (id) =>
    set((s) => ({
      notes: s.notes.filter((n) => n.id !== id),
      selectedNoteId: s.selectedNoteId === id ? null : s.selectedNoteId,
    })),

  updateNote: (id, patch) =>
    set((s) => ({
      notes: s.notes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    })),

  setSelectedNote: (selectedNoteId) => set({ selectedNoteId }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  setCurrentStep: (currentStep) => set({ currentStep }),
  replaceAll: (notes) => set({ notes, selectedNoteId: null }),
  clear: () => set({ notes: [], selectedNoteId: null, editingClipId: null }),

  setEditingClip: (editingClipId) => set({ editingClipId }),
  loadFromClip: (clipId, notes, bpm, totalSteps) =>
    set({
      notes: notes.map((n) => ({ ...n })),
      bpm: Math.max(40, Math.min(240, bpm)),
      totalSteps: Math.max(16, Math.min(256, totalSteps)),
      editingClipId: clipId,
      selectedNoteId: null,
      isPlaying: false,
      currentStep: 0,
    }),
}));

/** Convert the store's note list into the shared MIDI util's note format. */
export const pianoNotesToMidiNotes = (
  notes: PianoNote[],
  ppq: number,
): Array<{ tick: number; note: number; velocity: number; durationTicks: number; channel: number }> => {
  // 16th note = ppq / 4 ticks
  const stepTicks = ppq / 4;
  return notes.map((n) => ({
    tick: Math.round(n.step * stepTicks),
    note: n.note,
    velocity: Math.max(1, Math.min(127, n.velocity)),
    durationTicks: Math.max(1, Math.round(n.length * stepTicks)),
    channel: 0,
  }));
};
