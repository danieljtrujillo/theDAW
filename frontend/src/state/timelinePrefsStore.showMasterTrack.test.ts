import assert from 'node:assert/strict';

import { sanitizeTimelinePrefs, useTimelinePrefs } from './timelinePrefsStore.ts';

// showMasterTrack is a plain boolean view pref, additive to the v1 persisted
// shape (no version bump): old blobs without the field must hydrate to true.

const tp = () => useTimelinePrefs.getState();

/* -------------------------------- default is on -------------------------------- */
{
  assert.equal(tp().showMasterTrack, true);
}

/* -------------------------------- setter toggles -------------------------------- */
{
  tp().reset();
  tp().setShowMasterTrack(false);
  assert.equal(tp().showMasterTrack, false);
  tp().setShowMasterTrack(true);
  assert.equal(tp().showMasterTrack, true);
}

/* --------------------------- setter rejects non-boolean --------------------------- */
{
  tp().reset();
  tp().setShowMasterTrack('no' as never);
  assert.equal(tp().showMasterTrack, true, 'non-boolean is ignored');
}

/* ------------------------- old blob hydrates to default -------------------------- */
{
  tp().reset();
  const current = tp();
  const out = sanitizeTimelinePrefs({ wheelProfile: 'reaper' }, current);
  assert.equal(out.showMasterTrack, true);
  assert.equal(out.wheelProfile, 'reaper');
}

/* ---------------------------- persisted false survives ---------------------------- */
{
  tp().reset();
  const current = tp();
  const out = sanitizeTimelinePrefs({ showMasterTrack: false }, current);
  assert.equal(out.showMasterTrack, false);
}

/* -------------------------------- garbage falls back ------------------------------- */
{
  tp().reset();
  const current = tp();
  const out = sanitizeTimelinePrefs({ showMasterTrack: 3 }, current);
  assert.equal(out.showMasterTrack, true);
}

/* -------------------------------- reset restores default --------------------------- */
{
  tp().setShowMasterTrack(false);
  assert.equal(tp().showMasterTrack, false);
  tp().reset();
  assert.equal(tp().showMasterTrack, true);
}

console.log('timelinePrefsStore.showMasterTrack: ok');
