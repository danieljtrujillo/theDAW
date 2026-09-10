// OpenFileDialog filters for the native file picker (PathInput fileFilter /
// storageClient.pickFile). Each is "Label (*.ext;...)|*.ext;...|All files (*.*)|*.*"
// so the relevant types show first while "All files" stays available.

export const DAW_PROJECT_FILTER =
  'DAW projects (*.als;*.rpp;*.rpp-bak;*.flp;*.aup3;*.aup;*.sesx;*.bwproject;*.dawproject;*.avc;*.logicx;*.cpr;*.ptx;*.swayproj)' +
  '|*.als;*.rpp;*.rpp-bak;*.flp;*.aup3;*.aup;*.sesx;*.bwproject;*.dawproject;*.avc;*.logicx;*.cpr;*.ptx;*.swayproj' +
  '|All files (*.*)|*.*';

export const TASMO_FILTER = 'theDAW project (*.tasmo)|*.tasmo|All files (*.*)|*.*';

// The Session tab accepts both a saved theDAW project and any DAW project file.
export const SESSION_IMPORT_FILTER =
  'Session sources (*.tasmo;*.als;*.swayproj;*.rpp;*.flp;*.aup3;*.sesx;*.bwproject;*.dawproject;*.avc;*.logicx)' +
  '|*.tasmo;*.als;*.swayproj;*.rpp;*.rpp-bak;*.flp;*.aup3;*.aup;*.sesx;*.bwproject;*.dawproject;*.avc;*.logicx;*.cpr;*.ptx' +
  '|All files (*.*)|*.*';

export const GAN_FILTER = 'GAN plugin (*.gan)|*.gan|All files (*.*)|*.*';

/**
 * Every audio extension the library backend will take on import — the same set
 * `_resolve_audio_file` resolves in backend/modules/library/store.py, including
 * the DAW-native containers a float workflow reaches for (.w64, .rf64, .bwf,
 * .caf, .aifc).
 *
 * Spelled out rather than left to `audio/*`: Windows hands a lot of these over
 * with an empty mime type — a 32-bit float .wav written by another DAW, a .caf,
 * anything with no registered handler — and an `accept="audio/*"` picker then
 * greys out a file the backend would have imported fine.
 */
export const AUDIO_EXTS = [
  'wav', 'wave', 'w64', 'rf64', 'bwf', 'caf',
  'aif', 'aiff', 'aifc',
  'mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'wma',
] as const;

/** The same set as an `accept` list for `input[type=file]` (mime + extensions). */
export const AUDIO_ACCEPT = `audio/*,${AUDIO_EXTS.map((e) => `.${e}`).join(',')}`;

/** True when the filename's extension is one of AUDIO_EXTS (case-insensitive).
 *  Use this rather than a mime check on its own — the mime is often empty. */
export const hasAudioExt = (name: string): boolean => {
  const dot = name.lastIndexOf('.');
  // dot > 0 so a bare "wav" or a dotfile ".wav" is not read as an extension.
  return dot > 0 && (AUDIO_EXTS as readonly string[]).includes(name.slice(dot + 1).toLowerCase());
};

const AUDIO_GLOBS = AUDIO_EXTS.map((e) => `*.${e}`).join(';');
export const AUDIO_FILTER = `Audio (${AUDIO_GLOBS})|${AUDIO_GLOBS}|All files (*.*)|*.*`;
