import { create } from 'zustand';

/**
 * Global mirror of the assistant's busy state. AssistantPanel owns the real
 * processing lifecycle in local state; it mirrors the boolean here so surfaces
 * outside the panel (the orb's thinking visuals, the drip trail) can react
 * without the panel having to know they exist.
 */
interface AssistantActivityState {
  thinking: boolean;
  setThinking: (thinking: boolean) => void;
}

export const useAssistantActivityStore = create<AssistantActivityState>()((set) => ({
  thinking: false,
  setThinking: (thinking) => set({ thinking }),
}));
