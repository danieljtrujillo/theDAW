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

/**
 * The same bridge for CLIP selection.
 *
 * The editor store now owns a `selectedClipIds` array (the assistant's tools
 * write it), but WaveformEditor still keeps its own multi-selection in local
 * React state. Publishing here gives non-React readers one address for "what is
 * selected on the timeline" that does not depend on which of the two got there
 * first, and is what WaveformEditor will call when it adopts the store field.
 */
let _selectedClips: string[] = [];

export const publishSelectedClips = (ids: string[]): void => {
  _selectedClips = ids.slice();
};

export const getSelectedClips = (): string[] => _selectedClips;
