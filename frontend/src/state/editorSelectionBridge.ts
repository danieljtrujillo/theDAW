/**
 * Module-level bridge for the EDIT timeline's track selection.
 *
 * WaveformEditor keeps selection in local React state; it publishes the selected
 * track ids here so non-React code can read which track(s) are selected without
 * prop-drilling or a store dependency. The Sway control surface uses this for its
 * selection-following fader bank. Mirrors the editorPlaybackBridge pattern.
 */
let _selected: string[] = [];

export const publishSelectedTracks = (ids: string[]): void => {
  _selected = ids.slice();
};

export const getSelectedTracks = (): string[] => _selected;
