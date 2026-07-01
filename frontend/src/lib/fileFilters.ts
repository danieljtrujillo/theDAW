// OpenFileDialog filters for the native file picker (PathInput fileFilter /
// storageClient.pickFile). Each is "Label (*.ext;...)|*.ext;...|All files (*.*)|*.*"
// so the relevant types show first while "All files" stays available.

export const DAW_PROJECT_FILTER =
  'DAW projects (*.als;*.rpp;*.rpp-bak;*.flp;*.aup3;*.aup;*.sesx;*.bwproject;*.avc;*.logicx;*.cpr;*.ptx)' +
  '|*.als;*.rpp;*.rpp-bak;*.flp;*.aup3;*.aup;*.sesx;*.bwproject;*.avc;*.logicx;*.cpr;*.ptx' +
  '|All files (*.*)|*.*';

export const TASMO_FILTER = 'theDAW project (*.tasmo)|*.tasmo|All files (*.*)|*.*';

// The Session tab accepts both a saved theDAW project and any DAW project file.
export const SESSION_IMPORT_FILTER =
  'Session sources (*.tasmo;*.als;*.rpp;*.flp;*.aup3;*.sesx;*.bwproject;*.avc;*.logicx)' +
  '|*.tasmo;*.als;*.rpp;*.rpp-bak;*.flp;*.aup3;*.aup;*.sesx;*.bwproject;*.avc;*.logicx;*.cpr;*.ptx' +
  '|All files (*.*)|*.*';

export const GAN_FILTER = 'GAN plugin (*.gan)|*.gan|All files (*.*)|*.*';

export const AUDIO_FILTER =
  'Audio (*.wav;*.flac;*.mp3;*.ogg;*.m4a;*.aac;*.aif;*.aiff)' +
  '|*.wav;*.flac;*.mp3;*.ogg;*.m4a;*.aac;*.aif;*.aiff' +
  '|All files (*.*)|*.*';
