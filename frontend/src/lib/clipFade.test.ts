// clipFade: the one clip fade envelope. The suite pins three things:
//  1. the clamp rule (each fade inside the clip; when they collide the SMALLER
//     one shrinks, so a 90 % in / 10 % out fade survives),
//  2. the three curve shapes at 0/¼/½/¾/1 of the fade, and
//  3. that `applyFadeAutomation` and `fadeGainAt` are the SAME curve — the
//     recorded automation events are replayed through the AudioParam ramp rules
//     and sampled against the scalar evaluator.
import assert from 'node:assert/strict';
import {
  applyFadeAutomation, clampClipFades, fadeGainAt,
  FADE_EXP_FLOOR, FADE_EXP_TAIL,
  type AudioParamLike, type FadeClip,
} from './clipFade.ts';

type Ev =
  | { kind: 'set'; v: number; t: number }
  | { kind: 'lin'; v: number; t: number }
  | { kind: 'exp'; v: number; t: number }
  | { kind: 'curve'; values: number[]; t: number; dur: number };

type FakeParam = AudioParamLike & { events: Ev[] };

/** An AudioParam stand-in. `caps` drops a method so the duck-typed fallbacks
 *  (a param with no exponential ramp, or neither ramp nor curve) are exercised. */
const makeParam = (caps: { exp?: boolean; curve?: boolean } = {}): FakeParam => {
  const events: Ev[] = [];
  const p: FakeParam = {
    events,
    setValueAtTime(v, t) { events.push({ kind: 'set', v, t }); return p; },
    linearRampToValueAtTime(v, t) { events.push({ kind: 'lin', v, t }); return p; },
  };
  if (caps.exp !== false) {
    p.exponentialRampToValueAtTime = (v, t) => { events.push({ kind: 'exp', v, t }); return p; };
  }
  if (caps.curve !== false) {
    p.setValueCurveAtTime = (values, t, dur) => {
      events.push({ kind: 'curve', values: Array.from(values), t, dur });
      return p;
    };
  }
  return p;
};

/** Replay recorded events under the AudioParam automation rules: a value is
 *  held until the next event, a linear ramp interpolates linearly from the
 *  previous event, an exponential ramp geometrically, and a value curve is its
 *  samples spread evenly over its duration with linear interpolation between. */
const replay = (events: readonly Ev[], t: number): number => {
  let v = 0;
  let prevT = -Infinity;
  for (const e of events) {
    if (e.kind === 'curve') {
      if (t < e.t) return v;
      if (t <= e.t + e.dur) {
        const u = e.dur > 0 ? (t - e.t) / e.dur : 1;
        const x = u * (e.values.length - 1);
        const i0 = Math.min(e.values.length - 1, Math.max(0, Math.floor(x)));
        const i1 = Math.min(e.values.length - 1, i0 + 1);
        return e.values[i0] + (e.values[i1] - e.values[i0]) * (x - i0);
      }
      v = e.values[e.values.length - 1];
      prevT = e.t + e.dur;
      continue;
    }
    if (e.kind === 'set') {
      if (t < e.t) return v;
      v = e.v;
      prevT = e.t;
      continue;
    }
    if (t < e.t) {
      const span = e.t - prevT;
      if (span <= 0) return e.v;
      const u = (t - prevT) / span;
      if (u <= 0) return v;
      return e.kind === 'lin' ? v + (e.v - v) * u : v * Math.pow(e.v / v, u);
    }
    v = e.v;
    prevT = e.t;
  }
  return v;
};

const close = (a: number, b: number, eps: number, what: string) =>
  assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b} (eps ${eps})`);

// ── 1. The clamp rule ────────────────────────────────────────────────────────
{
  assert.deepEqual(clampClipFades({ durationSec: 10, fadeInSec: 2, fadeOutSec: 3 }), { fadeInSec: 2, fadeOutSec: 3 });
  // Missing fades are no fade.
  assert.deepEqual(clampClipFades({ durationSec: 10 }), { fadeInSec: 0, fadeOutSec: 0 });
  // Negative and non-finite are no fade.
  assert.deepEqual(clampClipFades({ durationSec: 10, fadeInSec: -1, fadeOutSec: Number.NaN }), { fadeInSec: 0, fadeOutSec: 0 });
  // Each fade alone is capped at the clip length.
  assert.deepEqual(clampClipFades({ durationSec: 4, fadeInSec: 9, fadeOutSec: 0 }), { fadeInSec: 4, fadeOutSec: 0 });
  assert.deepEqual(clampClipFades({ durationSec: 4, fadeInSec: 0, fadeOutSec: 9 }), { fadeInSec: 0, fadeOutSec: 4 });
  // 90 % in / 10 % out is legal — they fit exactly, nothing shrinks. The old
  // durationSec/2 cap would have cut this to 5/5.
  assert.deepEqual(clampClipFades({ durationSec: 10, fadeInSec: 9, fadeOutSec: 1 }), { fadeInSec: 9, fadeOutSec: 1 });
  // They collide: the SMALLER one shrinks to fit, the larger keeps its length.
  assert.deepEqual(clampClipFades({ durationSec: 10, fadeInSec: 9, fadeOutSec: 5 }), { fadeInSec: 9, fadeOutSec: 1 });
  assert.deepEqual(clampClipFades({ durationSec: 10, fadeInSec: 3, fadeOutSec: 8 }), { fadeInSec: 2, fadeOutSec: 8 });
  // Tie: fade-in keeps its length, fade-out gives way (documented tie-break).
  assert.deepEqual(clampClipFades({ durationSec: 10, fadeInSec: 8, fadeOutSec: 8 }), { fadeInSec: 8, fadeOutSec: 2 });
  // A zero-length (or bad) clip can hold no fade at all.
  assert.deepEqual(clampClipFades({ durationSec: 0, fadeInSec: 2, fadeOutSec: 2 }), { fadeInSec: 0, fadeOutSec: 0 });
  assert.deepEqual(clampClipFades({ durationSec: Number.NaN, fadeInSec: 2, fadeOutSec: 2 }), { fadeInSec: 0, fadeOutSec: 0 });
}

// ── 2. Curve shapes at 0/¼/½/¾/1 of each fade ────────────────────────────────
{
  const at = (clip: FadeClip, ts: number[]) => ts.map((t) => fadeGainAt(clip, t));

  // Linear: a 4 s fade-in over a 20 s clip.
  const linIn: FadeClip = { durationSec: 20, fadeInSec: 4 };
  assert.deepEqual(at(linIn, [0, 1, 2, 3, 4]), [0, 0.25, 0.5, 0.75, 1]);
  const linOut: FadeClip = { durationSec: 20, fadeOutSec: 4 };
  assert.deepEqual(at(linOut, [16, 17, 18, 19, 20]), [1, 0.75, 0.5, 0.25, 0]);

  // Equal power: sin / cos of t·π/2.
  const epIn: FadeClip = { durationSec: 20, fadeInSec: 4, fadeInCurve: 'equal-power' };
  [0, 0.25, 0.5, 0.75, 1].forEach((u) => {
    close(fadeGainAt(epIn, u * 4), Math.sin((u * Math.PI) / 2), 1e-12, `equal-power in @${u}`);
  });
  const epOut: FadeClip = { durationSec: 20, fadeOutSec: 4, fadeOutCurve: 'equal-power' };
  [0, 0.25, 0.5, 0.75, 1].forEach((u) => {
    close(fadeGainAt(epOut, 16 + u * 4), Math.cos((u * Math.PI) / 2), 1e-12, `equal-power out @${u}`);
  });

  // Exponential: linear in dB above a floor, with a short linear tail to true
  // silence. Endpoints are exact; the floor is hit at the end of the tail; the
  // midpoint of the dB leg is the geometric mean of floor and unity.
  const expIn: FadeClip = { durationSec: 20, fadeInSec: 4, fadeInCurve: 'exponential' };
  assert.equal(fadeGainAt(expIn, 0), 0);
  assert.equal(fadeGainAt(expIn, 4), 1);
  close(fadeGainAt(expIn, 4 * (FADE_EXP_TAIL / 2)), FADE_EXP_FLOOR / 2, 1e-12, 'exp in tail midpoint');
  close(fadeGainAt(expIn, 4 * FADE_EXP_TAIL), FADE_EXP_FLOOR, 1e-12, 'exp in floor');
  close(fadeGainAt(expIn, 4 * ((1 + FADE_EXP_TAIL) / 2)), Math.sqrt(FADE_EXP_FLOOR), 1e-12, 'exp in dB midpoint');
  // …and it rises monotonically the whole way.
  let prev = -1;
  for (let i = 0; i <= 400; i += 1) {
    const g = fadeGainAt(expIn, (i / 400) * 4);
    assert.ok(g >= prev, `exponential fade-in must not dip at ${i}`);
    prev = g;
  }
  // Fade-out is the mirror image.
  const expOut: FadeClip = { durationSec: 20, fadeOutSec: 4, fadeOutCurve: 'exponential' };
  assert.equal(fadeGainAt(expOut, 16), 1);
  assert.equal(fadeGainAt(expOut, 20), 0);
  [0, 0.25, 0.5, 0.75, 1].forEach((u) => {
    close(fadeGainAt(expOut, 16 + u * 4), fadeGainAt(expIn, (1 - u) * 4), 1e-12, `exponential mirror @${u}`);
  });

  // Unfaded stretches are unity; outside the clip there is nothing to hear.
  assert.equal(fadeGainAt({ durationSec: 20 }, 10), 1);
  assert.equal(fadeGainAt({ durationSec: 20 }, 0), 1);
  assert.equal(fadeGainAt({ durationSec: 20 }, 20), 1);
  assert.equal(fadeGainAt({ durationSec: 20 }, -0.001), 0);
  assert.equal(fadeGainAt({ durationSec: 20 }, 20.001), 0);

  // In-gain × out-gain where the two fades meet in the middle of a short clip.
  const both: FadeClip = { durationSec: 4, fadeInSec: 2, fadeOutSec: 2 };
  assert.equal(fadeGainAt(both, 1), 0.5);
  assert.equal(fadeGainAt(both, 2), 1);
  assert.equal(fadeGainAt(both, 3), 0.5);

  // The clamp is applied by the evaluator too: 9 + 5 on a 10 s clip is 9 + 1.
  const collide: FadeClip = { durationSec: 10, fadeInSec: 9, fadeOutSec: 5 };
  close(fadeGainAt(collide, 4.5), 0.5, 1e-12, 'clamped fade-in halfway');
  close(fadeGainAt(collide, 9.5), 0.5, 1e-12, 'clamped fade-out halfway');
}

// ── 3. Automation events: order, times and values ────────────────────────────
{
  // The default (linear) envelope, scheduled from the clip's head, is exactly
  // the four calls every current call site makes by hand.
  const clip: FadeClip = { durationSec: 10, fadeInSec: 2, fadeOutSec: 3 };
  const p = makeParam();
  applyFadeAutomation(p, clip, 5, 0, { peak: 0.5 });
  assert.deepEqual(p.events, [
    { kind: 'set', v: 0, t: 5 },
    { kind: 'lin', v: 0.5, t: 7 },
    { kind: 'set', v: 0.5, t: 12 },
    { kind: 'lin', v: 0, t: 15 },
  ]);

  // No fades: one call that parks the param at the clip's peak.
  const flat = makeParam();
  applyFadeAutomation(flat, { durationSec: 10 }, 5, 0, { peak: 0.5 });
  assert.deepEqual(flat.events, [{ kind: 'set', v: 0.5, t: 5 }]);

  // Unity peak is the default.
  const unity = makeParam();
  applyFadeAutomation(unity, { durationSec: 10 }, 5);
  assert.deepEqual(unity.events, [{ kind: 'set', v: 1, t: 5 }]);

  // Starting one second into the clip (mid fade-in): the envelope is anchored
  // at the value it already has, then finishes the fade.
  const mid = makeParam();
  applyFadeAutomation(mid, clip, 5, 1, { peak: 0.5 });
  assert.deepEqual(mid.events, [
    { kind: 'set', v: 0.25, t: 6 },
    { kind: 'lin', v: 0.5, t: 7 },
    { kind: 'set', v: 0.5, t: 12 },
    { kind: 'lin', v: 0, t: 15 },
  ]);

  // Starting inside the fade-OUT: no fade-in events, and the out ramp leaves
  // from the partial value rather than jumping back to full.
  const late = makeParam();
  applyFadeAutomation(late, clip, 5, 8, { peak: 0.5 });
  assert.equal(late.events.length, 2);
  assert.equal(late.events[0].kind, 'set');
  assert.equal(late.events[0].t, 13);
  close(late.events[0].v, (2 / 3) * 0.5, 1e-12, 'anchored inside the fade-out');
  assert.deepEqual(late.events[1], { kind: 'lin', v: 0, t: 15 });

  // Past the end of the clip there is nothing left to schedule.
  const done = makeParam();
  applyFadeAutomation(done, clip, 5, 10, { peak: 0.5 });
  assert.deepEqual(done.events, [{ kind: 'set', v: 0, t: 15 }]);

  // A silent clip is one call, never an exponential ramp towards zero.
  const silent = makeParam();
  applyFadeAutomation(silent, clip, 5, 0, { peak: 0 });
  assert.deepEqual(silent.events, [{ kind: 'set', v: 0, t: 5 }]);

  // The clamp reaches the schedule: 9 + 5 on a 10 s clip fades in over 9 s and
  // out over the last 1 s.
  const collide = makeParam();
  applyFadeAutomation(collide, { durationSec: 10, fadeInSec: 9, fadeOutSec: 5 }, 0);
  assert.deepEqual(collide.events, [
    { kind: 'set', v: 0, t: 0 },
    { kind: 'lin', v: 1, t: 9 },
    { kind: 'set', v: 1, t: 9 },
    { kind: 'lin', v: 0, t: 10 },
  ]);

  // Float noise must not buy a redundant anchor. Joining a 1.2 s fade 0.7 s in,
  // `ctxBase + (from / fadeSec) * fadeSec` is 0.7000000000000001 while
  // `whenSec + from` is 0.7 — the same instant, so only the fade's own opening
  // event should be emitted.
  assert.notEqual((0.7 / 1.2) * 1.2, 0.7, 'the premise: these really are an ULP apart');
  const ulp = makeParam();
  applyFadeAutomation(ulp, { durationSec: 5, fadeInSec: 1.2 }, 0, 0.7);
  assert.deepEqual(ulp.events.map((e) => e.kind), ['set', 'lin'], 'one anchor and one ramp, not two anchors');

  // Exponential ramps never target zero — the floor plus a linear tail do.
  const expP = makeParam();
  applyFadeAutomation(expP, { durationSec: 10, fadeInSec: 2, fadeOutSec: 3, fadeInCurve: 'exponential', fadeOutCurve: 'exponential' }, 0, 0, { peak: 0.5 });
  const expEvents = expP.events.filter((e) => e.kind === 'exp');
  assert.ok(expEvents.length >= 2, 'both exponential fades ramp exponentially');
  expEvents.forEach((e) => assert.ok(e.v >= FADE_EXP_FLOOR * 0.5, `exponential target ${e.v} is above the floor`));
  assert.ok(expP.events.some((e) => e.kind === 'lin' && e.v === 0), 'the fade-out still reaches true silence');
}

// ── 3b. The effective duration ───────────────────────────────────────────────
{
  // A clip whose decoded audio runs out before its nominal end must fade out at
  // the EFFECTIVE end. Every current call site works this length out by hand
  // (`min(durationSec, buffer.duration - offset)`) and nothing forces it to be
  // passed on, so it is an explicit option — taken by the evaluator too, which
  // is what keeps drawing and the schedule from drifting apart.
  const clip: FadeClip = { durationSec: 10, fadeInSec: 1, fadeOutSec: 2 };

  assert.equal(fadeGainAt(clip, 0, 4), 0);
  assert.equal(fadeGainAt(clip, 0.5, 4), 0.5);
  assert.equal(fadeGainAt(clip, 1, 4), 1);
  assert.equal(fadeGainAt(clip, 2, 4), 1);
  assert.equal(fadeGainAt(clip, 3, 4), 0.5);
  assert.equal(fadeGainAt(clip, 4, 4), 0);
  assert.equal(fadeGainAt(clip, 4.001, 4), 0);

  // Without it the very same clip is still at full gain at 4 s and does not
  // reach silence until 10 s.
  assert.equal(fadeGainAt(clip, 4), 1);
  assert.equal(fadeGainAt(clip, 10), 0);

  // The schedule ends at the effective end too.
  const p = makeParam();
  applyFadeAutomation(p, clip, 5, 0, { peak: 0.5, effectiveDurationSec: 4 });
  assert.deepEqual(p.events, [
    { kind: 'set', v: 0, t: 5 },
    { kind: 'lin', v: 0.5, t: 6 },
    { kind: 'set', v: 0.5, t: 7 },
    { kind: 'lin', v: 0, t: 9 },
  ]);

  // The clamp is applied against the effective length as well, so the fades
  // still fit: 1 + 2 will not fit in 2.5 s, and the smaller one shrinks.
  assert.deepEqual(clampClipFades({ durationSec: 2.5, fadeInSec: 1, fadeOutSec: 2 }), { fadeInSec: 0.5, fadeOutSec: 2 });
  assert.equal(fadeGainAt(clip, 0.25, 2.5), 0.5);

  // An effective length LONGER than the clip cannot stretch it.
  assert.equal(fadeGainAt(clip, 10, 99), 0);
  assert.equal(fadeGainAt(clip, 9, 99), 0.5);

  // A buffer that yields nothing is silence, not a park at full gain.
  const none = makeParam();
  applyFadeAutomation(none, clip, 5, 0, { peak: 0.5, effectiveDurationSec: 0 });
  assert.deepEqual(none.events, [{ kind: 'set', v: 0, t: 5 }]);
  assert.equal(fadeGainAt(clip, 0, 0), 0);
}

// ── 3c. A clip with no length at all ─────────────────────────────────────────
{
  // `tSec > dur` does not fire when both are zero, so this needs its own guard
  // — otherwise a zero-length clip reads as full gain and gets parked there.
  assert.equal(fadeGainAt({ durationSec: 0 }, 0), 0);
  assert.equal(fadeGainAt({ durationSec: Number.NaN }, 0), 0);
  assert.equal(fadeGainAt({ durationSec: -5 }, 0), 0);
  const p = makeParam();
  applyFadeAutomation(p, { durationSec: 0 }, 5, 0, { peak: 0.5 });
  assert.deepEqual(p.events, [{ kind: 'set', v: 0, t: 5 }]);
  const nan = makeParam();
  applyFadeAutomation(nan, { durationSec: Number.NaN, fadeInSec: 1 }, 5);
  assert.deepEqual(nan.events, [{ kind: 'set', v: 0, t: 5 }]);
}

// ── 4. The automation and the scalar evaluator are the same curve ────────────
{
  const CURVES = ['linear', 'exponential', 'equal-power'] as const;
  for (const curve of CURVES) {
    // Equal power is scheduled as a sampled value curve, so the replayed chord
    // sits a hair off the true sine between samples; the ramps are exact.
    const eps = curve === 'equal-power' ? 2e-4 : 1e-9;
    const clip: FadeClip = {
      durationSec: 12, fadeInSec: 3, fadeOutSec: 4, fadeInCurve: curve, fadeOutCurve: curve,
    };
    // …and the two stay in lockstep when the audio runs out early, which is the
    // whole point of the evaluator taking the effective length as well.
    for (const effectiveDurationSec of [undefined, 8]) {
      const end = effectiveDurationSec ?? clip.durationSec;
      for (const from of [0, 1.5, 3, 7, 9.5, 11]) {
        const p = makeParam();
        const when = 100;
        applyFadeAutomation(p, clip, when, from, { peak: 0.75, effectiveDurationSec });
        const start = Math.min(from, end);
        for (let i = 0; i <= 240; i += 1) {
          const t = start + ((end - start) * i) / 240;
          close(
            replay(p.events, when + t),
            fadeGainAt(clip, t, effectiveDurationSec) * 0.75,
            eps,
            `${curve} effective=${effectiveDurationSec} from ${from} at t=${t.toFixed(4)}`,
          );
        }
      }
    }
  }
}

// ── 5. Duck-typed fallbacks ──────────────────────────────────────────────────
{
  const clip: FadeClip = {
    durationSec: 12, fadeInSec: 3, fadeOutSec: 4, fadeInCurve: 'exponential', fadeOutCurve: 'equal-power',
  };

  // No exponential ramp: the value curve carries both shapes, still exactly.
  const noExp = makeParam({ exp: false });
  applyFadeAutomation(noExp, clip, 0);
  assert.ok(noExp.events.every((e) => e.kind !== 'exp'), 'no exponential ramp was used');
  assert.ok(noExp.events.some((e) => e.kind === 'curve'), 'the value curve carried the shape');
  // An exponential rasterised into chords is the worst case for this: its
  // curvature in dB space bounds the chord error at h²·(ln FLOOR)²/8 ≈ 6.5e-4
  // of full scale (about -63 dB) for the module's sample count.
  for (let i = 0; i <= 240; i += 1) {
    const t = (clip.durationSec * i) / 240;
    close(replay(noExp.events, t), fadeGainAt(clip, t), 1e-3, `curve fallback at t=${t.toFixed(4)}`);
  }

  // Neither: linear chords across each fade. The shape is an approximation, so
  // only the endpoints are pinned — but nothing is ever scheduled out of order.
  const plain = makeParam({ exp: false, curve: false });
  applyFadeAutomation(plain, clip, 0);
  assert.ok(plain.events.every((e) => e.kind === 'set' || e.kind === 'lin'), 'only plain ramps were used');
  let last = -Infinity;
  plain.events.forEach((e) => {
    assert.ok(e.t >= last, 'events are scheduled in time order');
    last = e.t;
  });
  close(replay(plain.events, 0), 0, 1e-12, 'plain fallback starts silent');
  close(replay(plain.events, 3), 1, 1e-12, 'plain fallback reaches unity');
  close(replay(plain.events, 8), 1, 1e-12, 'plain fallback holds unity');
  close(replay(plain.events, 12), 0, 1e-12, 'plain fallback ends silent');
}

console.log('clipFade: ok');
