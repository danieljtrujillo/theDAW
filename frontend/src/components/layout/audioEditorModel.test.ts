/**
 * node:assert cover for the Audio Editor's arithmetic. Run from `frontend/`:
 *   npx tsx src/components/layout/audioEditorModel.test.ts
 *
 * Every number the drawer writes to a clip comes from here, so this is where
 * the clamps live or die: a trim that reads past the end of the source, a fade
 * pair longer than the clip, a gain that inverts, a field that parses "12abc".
 */
import assert from 'node:assert/strict';

import { clampClipFades } from '../../lib/clipFade.ts';
import { MIN_CLIP_SEC } from '../../lib/clipDragMath.ts';
import {
  AUDIO_EDITOR_NUDGE_COARSE_SEC,
  AUDIO_EDITOR_NUDGE_SEC,
  CLIP_GAIN_DB_MAX,
  CLIP_GAIN_DB_MIN,
  clampGainDb,
  dbToGain,
  dragClipOf,
  fadeTargetOf,
  fitZoom,
  formatSeconds,
  gainToDb,
  parseNumberField,
  resetTrims,
  setFadeIn,
  setFadeOut,
  slipSourceTo,
  sourcePercentInWindow,
  sourceSecAtWindowFrac,
  sourceWindow,
  trimEndTo,
  trimStartTo,
  type ClipTrimEdit,
} from './audioEditorModel.ts';

/** A clip reading 2 s–6 s of a 10 s source, sitting at timeline second 4. */
const CLIP = { startSec: 4, durationSec: 4, offsetIntoSource: 2, sourceDuration: 10 };
/** The same audio at half speed: 4 s of source stretched over 8 s of timeline. */
const SLOW = { startSec: 4, durationSec: 8, offsetIntoSource: 2, sourceDuration: 10 };
const SLOW_RATE = 0.5;

const near = (a: number, b: number, eps = 1e-9, what = 'value'): void =>
  assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} is not within ${eps} of ${b}`);

/* ================================ TRIM START ============================== */
{
  // Moving the left edge later keeps the audio under the clip where it was:
  // the read head advances by exactly what the clip lost.
  const next = trimStartTo(CLIP, 1, 5) as ClipTrimEdit;
  assert.deepEqual(next, { startSec: 5, durationSec: 3, offsetIntoSource: 3 });

  // Moving it earlier reads further back into the source.
  assert.deepEqual(trimStartTo(CLIP, 1, 3), { startSec: 3, durationSec: 5, offsetIntoSource: 1 });

  // Refused, not clamped: there is no source before second zero, so the clip is
  // left exactly as it was and the caller writes nothing.
  assert.equal(trimStartTo(CLIP, 1, 1), null, 'a trim past the head of the source is refused');
  // Refused: the clip would be shorter than a clip is allowed to be.
  assert.equal(trimStartTo(CLIP, 1, 8), null, 'a trim that leaves nothing is refused');
  assert.equal(trimStartTo(CLIP, 1, 4 + 4 - MIN_CLIP_SEC), null, 'the minimum length is exclusive');

  // A stretched clip covers `rate` seconds of source per second of timeline, so
  // the read head moves by the timeline delta TIMES the rate — not by the delta.
  const slow = trimStartTo(SLOW, SLOW_RATE, 6) as ClipTrimEdit;
  assert.equal(slow.startSec, 6);
  assert.equal(slow.durationSec, 6, 'the clip lost 2 s of TIMELINE');
  near(slow.offsetIntoSource, 3, 1e-9, 'the read head advanced 1 s of SOURCE');
}

/* ================================= TRIM END =============================== */
{
  assert.deepEqual(trimEndTo(CLIP, 1, 6), { startSec: 4, durationSec: 2, offsetIntoSource: 2 });
  // Clamped, not refused: the right edge stops where the source runs out.
  // 2 s in, 10 s long -> at most 8 s of clip.
  assert.deepEqual(trimEndTo(CLIP, 1, 99), { startSec: 4, durationSec: 8, offsetIntoSource: 2 });
  // And it can never be dragged shorter than the minimum.
  assert.deepEqual(trimEndTo(CLIP, 1, 0), { startSec: 4, durationSec: MIN_CLIP_SEC, offsetIntoSource: 2 });

  // Stretched: 8 s of source are left after the read head, which at half speed
  // is 16 s of timeline.
  const slow = trimEndTo(SLOW, SLOW_RATE, 99);
  near(slow.durationSec, 16, 1e-9, 'the whole remaining source, in timeline seconds');
  near(slow.offsetIntoSource, 2, 1e-9, 'the read head is untouched by an end trim');
}

/* =================================== SLIP ================================= */
{
  // The clip does not move and does not change length; only the audio under it.
  const next = slipSourceTo(CLIP, 1, 5);
  assert.deepEqual(next, { startSec: 4, durationSec: 4, offsetIntoSource: 5 });

  assert.deepEqual(slipSourceTo(CLIP, 1, -3), { startSec: 4, durationSec: 4, offsetIntoSource: 0 },
    'slipping before the head of the source pins to it');
  // 4 s of clip in a 10 s source leaves 6 s of slack.
  assert.deepEqual(slipSourceTo(CLIP, 1, 99), { startSec: 4, durationSec: 4, offsetIntoSource: 6 },
    'slipping past the tail pins to the last full clip-length of source');

  // A source with no slack cannot slip at all, and is left where it reads
  // rather than being yanked to zero.
  const tight = { startSec: 0, durationSec: 10, offsetIntoSource: 0, sourceDuration: 10 };
  assert.deepEqual(slipSourceTo(tight, 1, 3), { startSec: 0, durationSec: 10, offsetIntoSource: 0 });

  // Stretched: the target is a SOURCE second and lands on it unchanged. (The
  // clamped cases below would pass even if the rate conversion were dropped,
  // because a pinned offset does not depend on how it was reached.)
  const slowMid = slipSourceTo(SLOW, SLOW_RATE, 5);
  near(slowMid.offsetIntoSource, 5, 1e-9, 'the read head lands on the source second asked for');
  assert.equal(slowMid.startSec, 4, 'a slip never moves the clip');
  assert.equal(slowMid.durationSec, 8, 'a slip never changes the length');

  // The clip covers 4 s of source (8 s of timeline at half speed), so the
  // slack is 6 s of SOURCE.
  const slow = slipSourceTo(SLOW, SLOW_RATE, 99);
  near(slow.offsetIntoSource, 6, 1e-9, 'slack is measured in source seconds');
  assert.equal(slow.durationSec, 8, 'a slip never changes the length');
}

/* ================================ RESET TRIMS ============================= */
{
  assert.deepEqual(resetTrims(CLIP, 1), { startSec: 4, durationSec: 10, offsetIntoSource: 0 },
    'the whole source plays again, from the same place on the timeline');
  const slow = resetTrims(SLOW, SLOW_RATE);
  near(slow.durationSec, 20, 1e-9, 'a half-speed clip needs twice the timeline for the same source');
  assert.equal(slow.offsetIntoSource, 0);

  // A source shorter than the minimum clip still leaves a clip you can grab.
  const tiny = { startSec: 1, durationSec: 0.2, offsetIntoSource: 0.1, sourceDuration: 0.01 };
  assert.equal(resetTrims(tiny, 1).durationSec, MIN_CLIP_SEC);
}

/* ==================== TRIM / SLIP: bad numbers are refused ================ */
{
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => trimStartTo(CLIP, 1, bad), RangeError, `trimStartTo(${bad})`);
    assert.throws(() => trimEndTo(CLIP, 1, bad), RangeError, `trimEndTo(${bad})`);
    assert.throws(() => slipSourceTo(CLIP, 1, bad), RangeError, `slipSourceTo(${bad})`);
    assert.throws(() => trimStartTo({ ...CLIP, sourceDuration: bad }, 1, 5), RangeError, 'a clip with a bad field');
  }
  for (const badRate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => trimStartTo(CLIP, badRate, 5), RangeError, `rate ${badRate}`);
    assert.throws(() => resetTrims(CLIP, badRate), RangeError, `rate ${badRate}`);
  }
}

/* =================================== FADES ================================ */
{
  const clip = { durationSec: 10, fadeInSec: 1, fadeOutSec: 2 };

  assert.deepEqual(setFadeIn(clip, 3), { fadeInSec: 3, fadeOutSec: 2 }, 'a fade that fits leaves the other alone');
  assert.deepEqual(setFadeOut(clip, 4), { fadeInSec: 1, fadeOutSec: 4 });

  // The field the user typed wins, and the OTHER fade gives way — the opposite
  // of clampClipFades, which shrinks whichever fade is smaller.
  assert.deepEqual(setFadeIn({ durationSec: 10, fadeInSec: 0, fadeOutSec: 9 }, 4),
    { fadeInSec: 4, fadeOutSec: 6 }, 'the edited fade-in keeps its length');
  assert.deepEqual(setFadeOut({ durationSec: 10, fadeInSec: 9, fadeOutSec: 0 }, 4),
    { fadeInSec: 6, fadeOutSec: 4 }, 'the edited fade-out keeps its length');

  // Neither fade can be longer than the clip, and neither can be negative.
  assert.deepEqual(setFadeIn(clip, 99), { fadeInSec: 10, fadeOutSec: 0 });
  assert.deepEqual(setFadeOut(clip, 99), { fadeInSec: 0, fadeOutSec: 10 });
  assert.deepEqual(setFadeIn(clip, -5), { fadeInSec: 0, fadeOutSec: 2 });
  assert.deepEqual(setFadeOut(clip, -5), { fadeInSec: 1, fadeOutSec: 0 });

  // A clip with no fades yet reads as zero rather than undefined.
  assert.deepEqual(setFadeIn({ durationSec: 8 }, 2), { fadeInSec: 2, fadeOutSec: 0 });

  // Whatever comes out is already a fixed point of the app's own fade clamp, so
  // the envelope the drawer shows is the envelope playback schedules.
  for (const [dur, inSec, outSec, set] of [
    [10, 0, 9, 4], [10, 9, 0, 4], [3, 1, 1, 2.5], [0.5, 0.1, 0.1, 0.4],
  ] as const) {
    for (const edit of [
      setFadeIn({ durationSec: dur, fadeInSec: inSec, fadeOutSec: outSec }, set),
      setFadeOut({ durationSec: dur, fadeInSec: inSec, fadeOutSec: outSec }, set),
    ]) {
      assert.ok(edit.fadeInSec >= 0 && edit.fadeOutSec >= 0, 'no negative fade');
      assert.ok(edit.fadeInSec + edit.fadeOutSec <= dur + 1e-12, 'the fades fit inside the clip');
      assert.deepEqual(clampClipFades({ durationSec: dur, ...edit }), edit, 'already clamped');
    }
  }

  // A clip with no length has no room for a fade at all.
  assert.deepEqual(setFadeIn({ durationSec: 0, fadeInSec: 1, fadeOutSec: 1 }, 5), { fadeInSec: 0, fadeOutSec: 0 });

  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => setFadeIn(clip, bad), RangeError);
    assert.throws(() => setFadeOut(clip, bad), RangeError);
    assert.throws(() => setFadeIn({ durationSec: bad }, 1), RangeError);
  }
}

/* ============================== DAMAGED CLIPS ============================== */
{
  // A clip carrying a field that did not survive a project load — or one
  // still mid-gesture — should never make it as far as `checkedClip`'s throw.
  assert.deepEqual(
    dragClipOf({ ...CLIP, sourceDuration: Number.NaN }, 7),
    { ...CLIP, sourceDuration: 7 },
    'dragClipOf replaces a NaN sourceDuration with the fallback',
  );

  assert.deepEqual(
    dragClipOf({ ...CLIP, sourceDuration: 0 }, 7),
    { ...CLIP, sourceDuration: 7 },
    'dragClipOf uses the fallback when sourceDuration is 0',
  );

  assert.deepEqual(
    dragClipOf({ ...CLIP, startSec: -5, offsetIntoSource: -2 }),
    { ...CLIP, startSec: 0, offsetIntoSource: 0 },
    'dragClipOf holds startSec and offsetIntoSource at or above zero',
  );

  assert.equal(
    dragClipOf({ ...CLIP, durationSec: Number.NaN }).durationSec,
    MIN_CLIP_SEC,
    'dragClipOf gives a NaN durationSec the minimum clip length',
  );

  // Every field wrong at once: no field's fallback may lean on another's.
  const allNaN = {
    startSec: Number.NaN,
    durationSec: Number.NaN,
    offsetIntoSource: Number.NaN,
    sourceDuration: Number.NaN,
  };
  assert.doesNotThrow(() => dragClipOf(allNaN), 'dragClipOf never throws on an all-NaN clip');
  assert.deepEqual(
    dragClipOf(allNaN),
    { startSec: 0, durationSec: MIN_CLIP_SEC, offsetIntoSource: 0, sourceDuration: 0 },
    'an all-NaN clip with no fallback sanitises to the safe defaults',
  );

  // The whole point of the fallback: a clip that lost its own sourceDuration
  // still restores the REAL source length, not the bare minimum clip length.
  const zeroSource = { startSec: 4, durationSec: 4, offsetIntoSource: 2, sourceDuration: 0 };
  assert.deepEqual(
    resetTrims(dragClipOf(zeroSource, 4), 1),
    { startSec: 4, durationSec: 4, offsetIntoSource: 0 },
    'resetTrims on dragClipOf(zero-source clip, 4) restores 4 seconds, not MIN_CLIP_SEC',
  );

  assert.deepEqual(
    fadeTargetOf({ durationSec: Number.NaN, fadeInSec: Number.NaN, fadeOutSec: -3 }),
    { durationSec: MIN_CLIP_SEC, fadeInSec: 0, fadeOutSec: 0 },
    'fadeTargetOf drops NaN and negative fades to zero',
  );
}

/* ==================================== GAIN ================================ */
{
  assert.equal(gainToDb(1), 0, 'unity is 0 dB');
  near(gainToDb(2), 6.0205999132, 1e-9, '2x');
  near(gainToDb(0.5), -6.0205999132, 1e-9, 'half');
  assert.equal(gainToDb(0), Number.NEGATIVE_INFINITY, 'silence has no dB');

  near(dbToGain(0), 1, 1e-12, '0 dB');
  near(dbToGain(6.0205999132), 2, 1e-9, '+6 dB');

  // dB in, dB out: the readout never lies about what is stored.
  for (const g of [0.001, 0.01, 0.25, 0.5, 1, 1.5, 2, 3.9]) {
    near(dbToGain(gainToDb(g)), g, 1e-9, `round trip ${g}`);
  }

  assert.equal(clampGainDb(CLIP_GAIN_DB_MAX + 40), CLIP_GAIN_DB_MAX);
  assert.equal(clampGainDb(CLIP_GAIN_DB_MIN - 40), CLIP_GAIN_DB_MIN);
  assert.equal(clampGainDb(Number.NEGATIVE_INFINITY), CLIP_GAIN_DB_MIN, 'silence reads as the bottom of the fader');
  assert.equal(clampGainDb(Number.POSITIVE_INFINITY), CLIP_GAIN_DB_MAX);
  assert.equal(dbToGain(CLIP_GAIN_DB_MIN - 99), dbToGain(CLIP_GAIN_DB_MIN), 'dbToGain clamps before it converts');

  // Gain is never negative and never inverts the signal.
  assert.ok(dbToGain(CLIP_GAIN_DB_MIN) > 0);
  assert.throws(() => gainToDb(-1), RangeError, 'a negative gain is not a gain');
  assert.throws(() => gainToDb(Number.NaN), RangeError);
  assert.throws(() => clampGainDb(Number.NaN), RangeError);
  assert.throws(() => dbToGain(Number.NaN), RangeError);
}

/* ============================== FIELD PARSING ============================= */
{
  assert.equal(parseNumberField('12'), 12);
  assert.equal(parseNumberField('  3.5  '), 3.5, 'whitespace around a number is fine');
  assert.equal(parseNumberField('-6'), -6);
  assert.equal(parseNumberField('+2.25'), 2.25);
  assert.equal(parseNumberField('.5'), 0.5);
  assert.equal(parseNumberField('5.'), 5);
  assert.equal(parseNumberField('0'), 0);

  for (const bad of ['', '   ', 'abc', '12abc', '1,5', '1 2', '-', '+', '.', '0x10', 'Infinity', 'NaN', '1e3']) {
    assert.equal(parseNumberField(bad), null, `"${bad}" is not a number a field means`);
  }
}

/* ================================ FORMATTING ============================== */
{
  assert.equal(formatSeconds(0), '0.000');
  assert.equal(formatSeconds(1.23456), '1.235');
  assert.equal(formatSeconds(1.23456, 1), '1.2');
  assert.equal(formatSeconds(12), '12.000');
  assert.throws(() => formatSeconds(Number.NaN), RangeError);
  assert.throws(() => formatSeconds(1, Number.NaN), RangeError);
}

/* =============================== SOURCE WINDOW ============================ */
{
  // 800 px at 100 px/s shows 8 s of a 60 s source, from second 10.
  const w = sourceWindow(60, 10, 100, 800);
  assert.deepEqual(w, { startSec: 10, endSec: 18, startFrac: 10 / 60, endFrac: 18 / 60 });

  // Scrolled past the tail: the window pins to the end rather than showing
  // nothing at all.
  assert.deepEqual(sourceWindow(60, 999, 100, 800), { startSec: 52, endSec: 60, startFrac: 52 / 60, endFrac: 1 });

  // Zoomed out further than the source is long: the whole source, from its head.
  assert.deepEqual(sourceWindow(4, 2, 10, 800), { startSec: 0, endSec: 4, startFrac: 0, endFrac: 1 });

  // Not measured yet (the frame before the panel knows its own width).
  assert.deepEqual(sourceWindow(60, 10, 100, 0), { startSec: 0, endSec: 60, startFrac: 0, endFrac: 1 });
  // A clip whose source length is not known yet cannot be divided by.
  assert.deepEqual(sourceWindow(0, 10, 100, 800), { startSec: 0, endSec: 0, startFrac: 0, endFrac: 1 });

  assert.throws(() => sourceWindow(60, 10, 0, 800), RangeError, 'a zoom of zero has no window');
  assert.throws(() => sourceWindow(60, 10, -5, 800), RangeError);
  assert.throws(() => sourceWindow(60, Number.NaN, 100, 800), RangeError);
  assert.throws(() => sourceWindow(Number.NaN, 0, 100, 800), RangeError);

  // Fit: the whole source across the measured width.
  assert.equal(fitZoom(60, 600), 10);
  assert.ok(fitZoom(60, 0) > 0, 'an unmeasured width still yields a usable zoom');
  assert.ok(fitZoom(0, 600) > 0, 'an unknown source length still yields a usable zoom');
  assert.deepEqual(sourceWindow(60, 0, fitZoom(60, 600), 600), { startSec: 0, endSec: 60, startFrac: 0, endFrac: 1 });
  assert.throws(() => fitZoom(Number.NaN, 600), RangeError);
}

/* ========================= WINDOW <-> SCREEN MAPPING ====================== */
{
  const w = sourceWindow(60, 10, 100, 800);   // 10 s .. 18 s

  assert.equal(sourcePercentInWindow(w, 10), 0, 'the left edge');
  assert.equal(sourcePercentInWindow(w, 18), 100, 'the right edge');
  assert.equal(sourcePercentInWindow(w, 14), 50, 'the middle');
  assert.equal(sourcePercentInWindow(w, 2), 0, 'off the left edge pins to it');
  assert.equal(sourcePercentInWindow(w, 99), 100, 'off the right edge pins to it');

  assert.equal(sourceSecAtWindowFrac(w, 0), 10);
  assert.equal(sourceSecAtWindowFrac(w, 1), 18);
  assert.equal(sourceSecAtWindowFrac(w, 0.25), 12);
  assert.equal(sourceSecAtWindowFrac(w, -1), 10, 'a pointer dragged off the left reads the left edge');
  assert.equal(sourceSecAtWindowFrac(w, 5), 18, 'a pointer dragged off the right reads the right edge');

  // A zero-width window (a source with no length) still answers, rather than
  // handing the caller a NaN to write into a clip.
  const empty = sourceWindow(0, 0, 100, 800);
  assert.equal(sourcePercentInWindow(empty, 0), 0);
  assert.equal(sourceSecAtWindowFrac(empty, 0.5), 0);

  assert.throws(() => sourcePercentInWindow(w, Number.NaN), RangeError);
  assert.throws(() => sourceSecAtWindowFrac(w, Number.NaN), RangeError);
}

/* ================================== NUDGE ================================= */
{
  assert.ok(AUDIO_EDITOR_NUDGE_SEC > 0);
  assert.ok(AUDIO_EDITOR_NUDGE_COARSE_SEC > AUDIO_EDITOR_NUDGE_SEC, 'Shift nudges further');
}

console.log('audioEditorModel: ok');
