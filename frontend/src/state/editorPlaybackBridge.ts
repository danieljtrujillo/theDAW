/**
 * Module-level bridge: WaveformEditor registers its play/stop callbacks when
 * mounted; PlayerFooter (and anything else) calls them without needing React
 * prop-drilling or circular store dependencies.
 */

let _play: (() => void) | null = null;
let _stop: (() => void) | null = null;

export const registerEditorPlayback = (play: () => void, stop: () => void): void => {
  _play = play;
  _stop = stop;
};

export const unregisterEditorPlayback = (): void => {
  _play = null;
  _stop = null;
};

export const callEditorPlay = (): void => { _play?.(); };
export const callEditorStop = (): void => { _stop?.(); };
export const isEditorPlaybackRegistered = (): boolean => _play !== null;
