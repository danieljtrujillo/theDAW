/**
 * recordingStore — the one `recordingEngine` instance, wired to the transport.
 *
 * `lib/recordingEngine.ts` shipped with no caller: it opens recorders, anchors
 * every take to the TRANSPORT second its `start` event landed on, and hands
 * takes back. It touches no store and draws nothing. This file is the seam
 * where it meets the app: arming, the record press, the count-in, the transport
 * and the clips the pass leaves behind.
 *
 * Who owns what
 * -------------
 *   - ARMING is owned HERE, not by the UI. `editorStore` already has the
 *     `armed` flag on a track (the red dot in the track header); this store
 *     subscribes to it and calls `engine.arm` / `engine.disarm` as the flag
 *     flips. A track is armed by flipping that flag and by nothing else, so the
 *     arm button, a project load and a script all arm identically.
 *   - The MIC PROFILE is owned here too. `micConstraints()` defaults to
 *     MicRecorder's voice-memo chain (echo cancellation, noise suppression and
 *     AGC all ON) because that is what a memo wants. A PERFORMANCE does not:
 *     AGC rides a crescendo flat, noise suppression gates a quiet tail and echo
 *     cancellation ducks a sustained tone. So the store supplies the engine's
 *     `getUserMedia` seam and rebuilds whatever constraints the engine asked
 *     for with `micConstraints({ musical: true })` on the way to the device —
 *     the seam exists precisely so the HOST picks the profile.
 *   - PLACEMENT is owned here: `takeClipPlacement` turns a take into clip
 *     coordinates and `editorStore.addClipToTrack` is given the same field set
 *     `lib/sendToTargets.ts:sendAudioToEditor` fills in, peaks included.
 *   - LATENCY COMPENSATION is owned here too, because placement is. The engine
 *     takes a `latencyCompSec` and always has; what it never had was a
 *     producer. `useRecordingPrefs.roundTrip` is that producer — one measured
 *     round trip per input device, written by the loopback calibrator
 *     (`lib/roundTripProbe.ts`) and read by `latencyCompSec()` on the way into
 *     `takeClipPlacement`. A device that was never measured compensates by 0,
 *     which is the behaviour every pass had before this existed.
 *
 * Two recorders, one press
 * ------------------------
 * A press drives TWO things: this store's mic engine, and `lib/midiCapture`'s
 * note capture (mounted in `App.tsx`, watching this store's `status`). The
 * engine opens one recorder per armed track and `placeTakes` lands one clip per
 * take, so an armed INSTRUMENT track once came out of a single press carrying a
 * mic take and a MIDI take stacked on top of each other.
 *
 * The split is made here, at the one point armed ids reach the engine
 * (`syncArmed`), and it reads `midiCapture`'s own `capturesMidi` predicate so
 * the two sides can never disagree about what a MIDI track is:
 *
 *   - `armedTrackIds` on THIS store stays every armed track. The RECORD key
 *     counts them and the capture picks its own tracks out of that list.
 *   - the ENGINE is armed only for the tracks `capturesMidi` rejects.
 *   - when it rejects none — every armed track is a MIDI track — no recorder is
 *     opened at all (`beginPass`), because the engine refuses an empty `start()`
 *     with `nothing-armed`. The PRESS is otherwise untouched: the transport is
 *     still released and the status still cycles `recording` -> `stopping` ->
 *     `idle`, which is precisely what opens and closes the capture. Nothing new
 *     is posted to `lastNotice`: from the user's side one press still made one
 *     take per armed track.
 *
 * Order of the press
 * ------------------
 * `engine.start()` resolves only once every recorder's `start` event has landed
 * — that event is what stamps the take — and the transport is started AFTER it.
 * `liveMixer.currentTransportSec()` returns `editorStore.playheadSec` while the
 * transport is stopped, so a take whose `onstart` lands before `play()` is
 * stamped at the playhead: recording from bar 9 puts the take at bar 9, which
 * is the wanted answer and the whole point of the anchor. Starting the
 * transport first would instead race the device open against a clock that is
 * already moving and lose the head of the take.
 *
 * When the clock does not move
 * ----------------------------
 * The anchor is right; the LENGTH is the part that can go wrong, because it is
 * `endSec - startSec` off that same clock. Three ways the clock refuses, and
 * one repair for all of them:
 *
 *   - an EMPTY project. `liveMixer.start()` returns at once when there are no
 *     clips, so `isPlaying` never turns on and `currentTransportSec()` reads
 *     the stationary playhead for the whole take: `endSec === startSec`. That
 *     is the FIRST take of every new project, so it is the common case, not an
 *     edge one.
 *   - any other early bail in `start()` (a decode that throws), for the same
 *     reason.
 *   - a LOOP region. `currentTransportSec()` rewinds at `loopEnd`, so a take
 *     that runs past it ends EARLIER on the clock than it began and
 *     `takeClipPlacement` floors the length at 0.
 *
 * In every one of them the recorded bytes are fine and know their own length,
 * so `placeTakes` repairs the clip from the decode: `computePeaks` hands back
 * the blob's duration and `applyClipRender` writes it in. That write is
 * history-exempt, so the pass is still ONE undo step.
 *
 * Punch in / punch out
 * --------------------
 * `punch` names the window the pass is allowed to WRITE into, and that window
 * is the editor's existing loop region (`editorStore.loopEnabled` /
 * `loopStart` / `loopEnd`) — there is no second region and no second owner.
 * Ardour's gate is `record_enabled && location && (punch_in || punch_out)`
 * (Ardour `session.cc:1797-1807`, GPL-3.0 — cited for the SHAPE of that rule
 * only; the file was not opened, no code from it is present here, and we
 * already had the `record_enabled` term as `armedTrackIds`). The `location`
 * term is the loop region and the two booleans are this store's `punch`.
 *
 * It is applied at the TAKE level, not in the engine: the engine keeps
 * recording the whole pass, so its `startSec` / `endSec` stay transport-true
 * and a punch mode changed mid-pass can never desync a recorder. `placeTakes`
 * then crops each take to the window — the clip keeps the whole take as its
 * source and slides its window in with `offsetIntoSource`, so the bytes
 * outside the punch are trimmed rather than destroyed and a drag of the clip's
 * edge brings them back. A take lying wholly outside the window is dropped.
 *
 * The crop and the length repair above do NOT overlap, by construction: the
 * crop needs a clock that measured the take, so it runs only when `measured`
 * is true, which is exactly when the repair does not. An unmeasured take — an
 * empty project, an early bail, or a pass that WRAPPED at `loopEnd` — is
 * therefore laid down un-cropped and repaired from the decode, as before. That
 * is also the wrap rule: one press is one take per armed track (the engine
 * hands back a single blob however many laps the transport made), so a pass
 * that wraps yields ONE clip, never one per lap.
 *
 * The window is fixed at the PRESS (`passPunchWindow`) and read again at the
 * stop, so dragging the loop region or changing the mode mid-pass cannot reach
 * back and re-cut a take that was recorded under the old one.
 *
 * `punch` is a persisted preference, like `metronomeStore`'s `countInBars` —
 * but it lives in its OWN store (`useRecordingPrefs`), because `persist` writes
 * storage on every `setState` of the store it wraps and THIS store is written
 * 20 times a second per pass. See that store for the whole argument.
 *
 * Seams
 * -----
 * Every outside reach is a `RecordingStoreDeps` entry with a real default, and
 * the engine itself arrives through a FACTORY (`createEngine`) so a test drives
 * the whole press with `recordingEngine.test.ts`-style fakes and never opens a
 * microphone, an `AudioContext` or a count-in scheduler.
 *
 * Nothing here is copied from any reference DAW under `oss-refs/`.
 */

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { persistBackend } from './persistStorage';
import {
  RecordingError,
  createRecordingEngine,
  micConstraints,
  takeClipPlacement,
  type LevelFrame,
  type RecordingDeps,
  type RecordingEngine,
  type Take,
} from '../lib/recordingEngine';
import { clipStretchRate, computePeaks, useEditorStore } from './editorStore';
import { usePlayerStore } from './playerStore';
import { currentTransportSec } from './liveMixer';
import {
  cancelMetronomeCountIn,
  metronomeCountIn,
  shouldCountIn,
  useMetronomeStore,
} from './metronomeStore';
import { callEditorPlay } from './editorPlaybackBridge';
import { resolveGlobal } from './ioDevicesStore';
import { capturesMidi } from '../lib/midiCapture';
import type { ClipTake } from '../lib/clipComp';
import { matchClipForTake, nextTakeLabel, takeReadOffsetFor } from '../lib/takePlacement';
import { EDITOR_TIMELINE_ID } from '../components/audio/trackMenuModel';

/* -------------------------------------------------------------------------- */
/*                                   types                                    */
/* -------------------------------------------------------------------------- */

/**
 * `idle` -> `counting` (only when the metronome is counting this press in) ->
 * `recording` -> `stopping` -> `idle`. The footer's RECORD key is latched for
 * every state but `idle`, and a press in any of them stops instead of starting.
 */
export type RecordingStatus = 'idle' | 'counting' | 'recording' | 'stopping';

/**
 * Which edges of the loop region the pass is allowed to write across.
 *   - `off`    — no window; the whole pass lands.
 *   - `in`     — from `loopStart` onward.
 *   - `out`    — up to `loopEnd`.
 *   - `in-out` — between the two.
 */
export type PunchMode = 'off' | 'in' | 'out' | 'in-out';

/** The modes the UI offers, in the order it offers them. */
export const PUNCH_CHOICES: readonly PunchMode[] = ['off', 'in', 'out', 'in-out'];

/** What `lastNotice` carries when a punch mode is set but there is no region to
 *  punch into. INFORMATIONAL, and deliberately NOT a `RecordingError`: the
 *  press records normally, so the notice says why the mode did nothing rather
 *  than claiming the pass failed. */
export const PUNCH_IGNORED_MESSAGE = 'Punch ignored: no loop region - set one on the timeline first.';

/** What `lastNotice` carries when the punch window kept nothing of a pass. The
 *  recorders ran and the user pressed stop, so a silent timeline needs a word. */
export const PUNCH_EMPTY_MESSAGE = 'Punch window empty: no take kept - the pass fell outside the loop region.';

/** One informational word from a press. `seq` is what makes the SAME message
 *  twice two notices: the footer keys its post on this object, and two presses
 *  that both ignore the punch must both say so. */
export interface RecordingNotice {
  text: string;
  seq: number;
}

/** Coerce anything — a stale persisted value included — to a real mode. */
const asPunchMode = (v: unknown): PunchMode =>
  (PUNCH_CHOICES as readonly unknown[]).includes(v) ? (v as PunchMode) : 'off';

/**
 * What a pass does when it lands on top of a clip that is already there.
 *
 *   - `takes` — it becomes an alternate TAKE of that clip and the clip plays
 *     it (`lib/takePlacement` decides which clip, if any). The default: a
 *     performer re-recording a phrase means the new pass to replace the old
 *     one, and stacking a second clip over the first only sounds like both.
 *   - `clips` — every pass lands as its own clip, which is what every pass did
 *     before takes existed. Kept as a preference rather than removed, because
 *     layering IS what a user overdubbing a harmony onto the same lane wants.
 */
export type TakeMode = 'takes' | 'clips';

export const TAKE_MODES: readonly TakeMode[] = ['takes', 'clips'];

/** Coerce anything — a stale persisted value included — to a real take mode. */
const asTakeMode = (v: unknown): TakeMode =>
  (TAKE_MODES as readonly unknown[]).includes(v) ? (v as TakeMode) : 'takes';

/* -------------------------------------------------------------------------- */
/*                        the round-trip calibration                          */
/* -------------------------------------------------------------------------- */

/**
 * One device's measured input→output round trip.
 *
 * `ms` is the WHOLE loop — see `lib/roundTripLatency.roundTripMs` for why both
 * halves carry the same sign against the grid. `confidence` and `measuredAt`
 * are kept because a saved number the user cannot judge is worse than none:
 * the calibrator shows both, so a 0.55-confidence reading from six months ago
 * is visibly a candidate for re-running rather than a fact.
 */
export interface RoundTripEntry {
  /** The loop, milliseconds. Always finite and >= 0. */
  ms: number;
  /** ISO timestamp of the run that produced it. */
  measuredAt: string;
  /** `estimateOffset`'s confidence, 0..1. */
  confidence: number;
}

/**
 * Widest round trip that is a measurement rather than a mistake, ms. A second
 * is already an unusable device stack; anything past it is a mis-correlation,
 * and clamping it here keeps a bad persisted entry from throwing every take at
 * the front of the timeline.
 */
export const ROUND_TRIP_MAX_MS = 1000;

/**
 * How the calibration map is keyed: the RESOLVED input device id, with `''`
 * meaning "whatever the OS calls the default" — which is `ioResolve.Resolved`'s
 * own contract for that field, so nothing here invents a second convention.
 */
export type DeviceKey = string;

/** Drop anything that is not a usable entry. Used on hydrate AND on write, so
 *  a caller cannot put a NaN in either. */
const asRoundTripEntry = (v: unknown): RoundTripEntry | null => {
  if (!v || typeof v !== 'object') return null;
  const e = v as { ms?: unknown; measuredAt?: unknown; confidence?: unknown };
  if (typeof e.ms !== 'number' || !Number.isFinite(e.ms) || e.ms < 0 || e.ms > ROUND_TRIP_MAX_MS) return null;
  const confidence =
    typeof e.confidence === 'number' && Number.isFinite(e.confidence)
      ? Math.min(1, Math.max(0, e.confidence))
      : 0;
  return {
    ms: e.ms,
    measuredAt: typeof e.measuredAt === 'string' ? e.measuredAt : '',
    confidence,
  };
};

/** Every usable entry of a persisted map, and nothing else. */
export function asRoundTripMap(v: unknown): Record<DeviceKey, RoundTripEntry> {
  const out: Record<DeviceKey, RoundTripEntry> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof key !== 'string') continue;
    const entry = asRoundTripEntry(value);
    if (entry) out[key] = entry;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*                            the preference store                            */
/* -------------------------------------------------------------------------- */

export interface RecordingPrefsState {
  /** The punch window's mode. */
  punch: PunchMode;
  /**
   * Measured round trip per input device. Keyed by `DeviceKey`; absent means
   * "never measured on this device", which is 0 compensation — today's
   * behaviour, unchanged for anyone who never opens the calibrator.
   */
  roundTrip: Record<DeviceKey, RoundTripEntry>;
  /** Where a pass lands when a clip is already there. Anything unknown falls
   *  back to `takes`. */
  takeMode: TakeMode;
  /** Choose it. Anything unknown falls back to `off`. */
  setPunch: (mode: PunchMode) => void;
  /** Choose it. Anything unknown falls back to `takes`. */
  setTakeMode: (mode: TakeMode) => void;
  /** Save a measurement for one device. A value that is not a usable entry
   *  (NaN, negative, past `ROUND_TRIP_MAX_MS`) CLEARS that device instead of
   *  being stored — a bad number must never reach take placement. */
  setRoundTrip: (deviceKey: DeviceKey, entry: RoundTripEntry) => void;
  /** Forget one device's measurement. */
  clearRoundTrip: (deviceKey: DeviceKey) => void;
}

/**
 * The punch PREFERENCE, persisted — and deliberately a store of its OWN.
 *
 * `persist` replaces `api.setState`, so every write to the store it wraps
 * serialises the state and hits `localStorage` synchronously. `useRecordingStore`
 * is written 20 times a second per pass (the meter frames), plus on every status
 * flip, and its actions are documented as never throwing — a storage that is
 * full, disabled or in a locked-down iframe would throw out of `recordPress`
 * and `placeTakes`. So the hot store stays UNWRAPPED and this one, written only
 * when the user picks a mode, carries the persistence. The hot store reads it.
 *
 * `merge` validates on hydrate: a value this build does not know (a mode a
 * future build added, or a hand-edited entry) becomes `off` rather than a
 * window nothing can compute.
 */
/** The three methods `persist` asks of a storage. `localStorage` satisfies it. */
export interface PrefsStorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/**
 * Where the preference is written. A seam because zustand 5.0.15 attaches NO
 * `persist` api to the store (only `setState` / `getState` / `getInitialState` /
 * `subscribe` are there), so there is no other way for a host — or a test with
 * no `localStorage` — to point it somewhere else. `null` restores the default.
 */
let prefsStorage: PrefsStorageLike | null = null;
export function setRecordingPrefsStorage(storage: PrefsStorageLike | null): void {
  prefsStorage = storage;
}

/** Where the preference goes without a host override: the shared persist
 *  backend, which keeps the value in memory for the session (and says so once
 *  in the LOG) when a server render, a locked-down iframe or a browser with
 *  storage disabled leaves no localStorage. */
const backend = (): PrefsStorageLike => prefsStorage ?? persistBackend;

/**
 * ONE object handed to `persist`, which resolves the real backend per call.
 * `createJSONStorage` calls its getter ONCE and caches the result, so a getter
 * that returned the backend directly would freeze whatever was available at
 * import — and a `null` there makes zustand throw on every write rather than
 * warn. Every method swallows: a storage that refuses must never throw out of
 * `setPunch`.
 */
const prefsJsonBackend: PrefsStorageLike = {
  getItem: (key) => {
    try {
      return backend().getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      backend().setItem(key, value);
    } catch {
      /* full, disabled, or denied: the preference is still live in memory */
    }
  },
  removeItem: (key) => {
    try {
      backend().removeItem(key);
    } catch {
      /* as above */
    }
  },
};

/**
 * What a persisted entry becomes on hydrate. Exported because it IS the
 * validation: a value this build does not know (a mode a future build added, a
 * hand-edited entry) has to become `off` rather than a window nothing can
 * compute, and `persist` gives no way to drive its own hydrate from a test.
 */
export function mergeRecordingPrefs(
  persisted: unknown,
  current: RecordingPrefsState,
): RecordingPrefsState {
  const p = persisted as { punch?: unknown; roundTrip?: unknown; takeMode?: unknown } | null;
  return {
    ...current,
    punch: asPunchMode(p?.punch),
    roundTrip: asRoundTripMap(p?.roundTrip),
    takeMode: asTakeMode(p?.takeMode),
  };
}

export const useRecordingPrefs = create<RecordingPrefsState>()(
  persist(
    (set) => ({
      punch: 'off',
      roundTrip: {},
      takeMode: 'takes',
      setPunch: (mode: PunchMode) => set({ punch: asPunchMode(mode) }),
      setTakeMode: (mode: TakeMode) => set({ takeMode: asTakeMode(mode) }),
      setRoundTrip: (deviceKey: DeviceKey, entry: RoundTripEntry) =>
        set((s) => {
          const clean = asRoundTripEntry(entry);
          const next = { ...s.roundTrip };
          if (clean) next[deviceKey] = clean;
          else delete next[deviceKey];
          return { roundTrip: next };
        }),
      clearRoundTrip: (deviceKey: DeviceKey) =>
        set((s) => {
          if (!(deviceKey in s.roundTrip)) return {};
          const next = { ...s.roundTrip };
          delete next[deviceKey];
          return { roundTrip: next };
        }),
    }),
    {
      name: 'thedaw-recording-prefs',
      version: 1,
      storage: createJSONStorage(() => prefsJsonBackend),
      partialize: (s) => ({ punch: s.punch, roundTrip: s.roundTrip, takeMode: s.takeMode }),
      merge: (persisted, current) => mergeRecordingPrefs(persisted, current),
    },
  ),
);

/** The mode a press would punch with. */
export const punchMode = (): PunchMode => useRecordingPrefs.getState().punch;

/** Where a pass made RIGHT NOW would land on top of an existing clip. */
export const takeMode = (): TakeMode => useRecordingPrefs.getState().takeMode;

/**
 * Which device a calibration belongs to.
 *
 * The recorder opens the microphone with NO device id
 * (`syncArmed` arms `{ kind: 'mic' }`, and `musicalConstraints` carries over
 * only what it was given), so today every pass records on whatever the OS calls
 * the default — which is what `resolveGlobal('audio_input')` reports as `''`
 * when the user has chosen nothing. Keying on the resolved id rather than on
 * the literal empty string means a user who HAS picked a global input keeps
 * their calibration filed under that device, and the calibrator measures
 * through the same id, so the two always agree about what was measured.
 */
export const recordingDeviceKey = (): DeviceKey => {
  try {
    return resolveGlobal('audio_input').deviceId;
  } catch {
    // `placeTakes` is on the press path, whose actions are documented as never
    // throwing. A resolution that cannot run means "no named device", which is
    // the OS-default key — the same answer a fresh install gives.
    return '';
  }
};

/**
 * The measurement for the device a press would use, or `null`.
 *
 * Deliberately NOT a hook: `placeTakes` runs outside React.
 */
export const roundTripFor = (deviceKey: DeviceKey = recordingDeviceKey()): RoundTripEntry | null =>
  useRecordingPrefs.getState().roundTrip[deviceKey] ?? null;

/**
 * What `takeClipPlacement` must remove from a take's start, seconds.
 *
 * `recordingEngine.ts:300-319`: the parameter has been there since the engine
 * landed, documented as "the input round trip", with no producer in `src` —
 * this is that producer. Absent (never measured, or a persisted entry this
 * build rejected) is 0, which is exactly the behaviour every pass has today.
 */
export function latencyCompSec(deviceKey: DeviceKey = recordingDeviceKey()): number {
  const entry = roundTripFor(deviceKey);
  return entry ? entry.ms / 1000 : 0;
}

export interface RecordingStoreState {
  status: RecordingStatus;
  /** Record-armed track ids, mirroring `editorStore`'s `armed` flags in order. */
  armedTrackIds: string[];
  /** Latest meter frame per armed track, written at most every
   *  `LEVEL_WRITE_MS`. Emptied when a pass ends. */
  levels: Record<string, LevelFrame>;
  /** The last failure, for the footer to surface. A fresh object every time, so
   *  the same failure twice is still two notices. */
  lastError: RecordingError | null;
  /** The last INFORMATIONAL word from a press — something the user should know
   *  about a pass that is otherwise proceeding normally. A separate channel
   *  from `lastError` because the footer labels that one "RECORD FAILED", and a
   *  notice posted under that label would be a lie about what happened. Set and
   *  cleared on the press, exactly like `lastError`. */
  lastNotice: RecordingNotice | null;
  /** Start a pass, or stop the one running. Never throws. */
  recordPress: () => void;
  /** Stop a pass (or cancel a count-in). Never throws. */
  stopRecording: () => void;
  /** Dismiss whatever the last press had to say — the failure and the notice. */
  clearError: () => void;
}

/** Everything this store reaches outside itself. Every entry has a real default. */
export interface RecordingStoreDeps {
  /** THE factory seam: how the one engine is built. */
  createEngine: (deps: RecordingDeps) => RecordingEngine;
  /** What the engine is built with, bar `now` (which is `transportSec`). */
  engineEnv: Omit<RecordingDeps, 'now'>;
  /** Transport seconds — `liveMixer.currentTransportSec`. */
  transportSec: () => number;
  /** Wall clock, for the level write throttle only. */
  nowMs: () => number;
  /** Start the EDIT transport. Mirrors `PlayerFooter`'s own `startTransport`. */
  startTransport: () => void;
  /** Is the transport rolling right now? */
  isTransportPlaying: () => boolean;
  /** Transport playing changes. Returns an unsubscribe. */
  subscribeTransport: (cb: (playing: boolean) => void) => () => void;
  /** Record-armed track ids, in track order. */
  armedTrackIds: () => string[];
  /** Arm-flag changes. Returns an unsubscribe. */
  subscribeArmed: (cb: (ids: string[]) => void) => () => void;
  /** Play the count-in and call `onDone` at its end, returning the cancel — or
   *  `null` when THIS press does not count in, in which case `onDone` is not
   *  called and the caller starts at once. */
  beginCountIn: (onDone: () => void) => (() => void) | null;
  /** Silence a count-in in flight. */
  cancelCountIn: () => void;
  /** Waveform peaks for a placed take. */
  computePeaks: (blob: Blob, bins?: number) => Promise<{ peaks: Float32Array; duration: number }>;
}

/* -------------------------------------------------------------------------- */
/*                                 constants                                  */
/* -------------------------------------------------------------------------- */

/**
 * How often the meter frames reach the STORE. The engine feeds them at
 * `RECORDING_LEVEL_INTERVAL_MS` (40 ms, 25 Hz) per armed track; a zustand write
 * per track per frame would re-render every subscriber 25 times a second per
 * track. Coalescing to one write per 50 ms keeps the meter above the 20 Hz a
 * meter needs while the store settles at 20 writes a second however many tracks
 * are armed.
 */
export const LEVEL_WRITE_MS = 50;

/** Peak bins per placed take — `sendToTargets.sendAudioToEditor`'s number. */
const TAKE_PEAK_BINS = 240;

/** The colour a clip falls back to, as in `sendToTargets.sendAudioToEditor`. */
const FALLBACK_CLIP_COLOR = '#8b5cf6';

/* -------------------------------------------------------------------------- */
/*                              the mic profile                               */
/* -------------------------------------------------------------------------- */

/**
 * Rebuild constraints the engine asked for with the MUSICAL profile, keeping
 * whatever device it named. Exported because it is the whole of the store's mic
 * policy and is worth reading (and testing) on its own.
 *
 * The device id is the ONLY field carried over, which is the whole of what
 * `openGroup` — the single caller today — asks for: it builds its constraints
 * with `micConstraints(source.deviceId)`, so `deviceId` plus the three
 * processors IS the object. Anything else a future caller puts in `audio` would
 * be dropped here; widen this the day there is one.
 */
export function musicalConstraints(asked: MediaStreamConstraints): MediaStreamConstraints {
  const audio = asked.audio;
  const deviceId =
    audio && typeof audio === 'object' && typeof (audio as MediaTrackConstraints).deviceId === 'string'
      ? ((audio as MediaTrackConstraints).deviceId as string)
      : undefined;
  return micConstraints({ deviceId, musical: true });
}

function realGetUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return Promise.reject(
      new RecordingError('unsupported', 'getUserMedia is not available in this browser.'),
    );
  }
  return navigator.mediaDevices.getUserMedia(musicalConstraints(constraints));
}

/* -------------------------------------------------------------------------- */
/*                               real defaults                                */
/* -------------------------------------------------------------------------- */

/** The armed ids, in track order, so a take batch reads top-down. */
function armedIdsFromEditor(): string[] {
  return useEditorStore
    .getState()
    .tracks.filter((t) => t.armed === true)
    .map((t) => t.id);
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

const defaultDeps: RecordingStoreDeps = {
  createEngine: createRecordingEngine,
  engineEnv: { getUserMedia: realGetUserMedia },
  transportSec: currentTransportSec,
  nowMs: () => Date.now(),
  // The same branch `PlayerFooter`'s own `startTransport` takes: the EDIT
  // timeline has to be RENDERED into the player before the footer's toggle can
  // drive it, and `callEditorPlay` is what does that. A transport already
  // rolling is left alone — a record press must never pause it.
  startTransport: () => {
    const player = usePlayerStore.getState();
    if (player.isPlaying) return;
    if (player.currentEntryId !== EDITOR_TIMELINE_ID) callEditorPlay();
    else player.toggle();
  },
  // liveMixer has no subscription of its own, but it PUBLISHES its playing
  // state: `play` / `pause` / `stop` all write `usePlayerStore.isPlaying`.
  isTransportPlaying: () => usePlayerStore.getState().isPlaying,
  subscribeTransport: (cb) =>
    usePlayerStore.subscribe((s, prev) => {
      if (s.isPlaying !== prev.isPlaying) cb(s.isPlaying);
    }),
  armedTrackIds: armedIdsFromEditor,
  subscribeArmed: (cb) =>
    useEditorStore.subscribe((s, prev) => {
      if (s.tracks === prev.tracks) return;
      cb(armedIdsFromEditor());
    }),
  // `shouldCountIn` is asked FIRST so a press that does not count in never
  // reaches the scheduler (which would call `onDone` synchronously and hand
  // back a no-op cancel that the caller could not tell from a real one).
  // `editor: true` / `playing: false`: a record press only ever exists on EDIT,
  // and it only ever starts.
  beginCountIn: (onDone) => {
    const { countInBars: bars, enabled } = useMetronomeStore.getState();
    if (!shouldCountIn({ editor: true, playing: false, bars, enabled })) return null;
    return metronomeCountIn(onDone, { editor: true, playing: false });
  },
  cancelCountIn: cancelMetronomeCountIn,
  computePeaks: (blob, bins) => computePeaks(blob, bins),
};

let deps: RecordingStoreDeps = { ...defaultDeps };

/**
 * Replace some of the outside reaches. For the tests, and for a host that has
 * to drive a different transport. Takes effect on the next `initRecording()`;
 * call `resetRecording()` first if the service is already up.
 */
export function setRecordingDeps(partial: Partial<RecordingStoreDeps>): void {
  deps = { ...deps, ...partial };
}

/* -------------------------------------------------------------------------- */
/*                                 the store                                  */
/* -------------------------------------------------------------------------- */

let engine: RecordingEngine | null = null;
let subscriptions: Array<() => void> = [];
let started = false;
/** The cancel of the count-in in flight, if any. */
let countInCancel: (() => void) | null = null;
/** True from the record press until `engine.start()` settles. */
let startInFlight = false;
/** Did THIS pass open mic recorders at all? False when every armed track is a
 *  MIDI track — see `beginPass`. `finishPass` reads it so a pass that opened
 *  nothing is not stopped, and the engine is never asked for takes it has not
 *  got. */
let micPassOpen = false;
/** A stop that arrived while `start()` was still in flight. */
let stopPending = false;
/** Did the transport actually roll for the pass being placed? When it did not,
 *  the take's clock never moved and its length has to come from the decode
 *  instead — see the header. */
let transportRolled = false;
/** Take numbering, for the clip labels. Session-wide and monotonic, so two
 *  passes never both call their clip "Take 1". */
let takeSeq = 0;
let pendingLevels: Record<string, LevelFrame> = {};
let lastLevelWrite = 0;
/** The window THIS pass was pressed with, captured at the press. The crop runs
 *  at the stop, and between the two the user may drag the loop region or change
 *  the mode; neither may reach back and re-cut a take that was already recorded
 *  under the old one. The press is also where the "no loop region" notice is
 *  decided, so the notice and the crop always describe the same window. */
let passPunchWindow: { from: number; to: number } | null = null;
/** Bumped per notice, so the same text twice is still two notices. */
let noticeSeq = 0;

const notice = (text: string): RecordingNotice => {
  noticeSeq += 1;
  return { text, seq: noticeSeq };
};

const st = () => useRecordingStore.getState();
const setState = (patch: Partial<RecordingStoreState>): void => {
  useRecordingStore.setState(patch);
};

const asRecordingError = (e: unknown): RecordingError =>
  e instanceof RecordingError
    ? e
    : new RecordingError('unsupported', e instanceof Error ? e.message : String(e), e);

function getEngine(): RecordingEngine {
  if (engine) return engine;
  engine = deps.createEngine({ ...deps.engineEnv, now: deps.transportSec });
  subscriptions.push(
    engine.onLevel((trackId, frame) => {
      pendingLevels[trackId] = frame;
      const now = deps.nowMs();
      if (now - lastLevelWrite < LEVEL_WRITE_MS) return;
      lastLevelWrite = now;
      setState({ levels: { ...st().levels, ...pendingLevels } });
      pendingLevels = {};
    }),
  );
  return engine;
}

/**
 * Which of the armed ids the MIC records — every one `lib/midiCapture` does not
 * take (see the header's "Two recorders, one press").
 *
 * An id with no track behind it is kept: `armedTrackIds` is a seam and a host
 * may name a track this store cannot see, and the old behaviour for such an id
 * was to arm a recorder for it.
 */
function micArmedIds(ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  const { tracks, clips } = useEditorStore.getState();
  const wanted = new Set(ids);
  const byId = new Map(tracks.filter((t) => wanted.has(t.id)).map((t) => [t.id, t]));
  return ids.filter((id) => {
    const track = byId.get(id);
    return track ? !capturesMidi(track, clips) : true;
  });
}

/**
 * Mirror `ids` onto the store, and the MIC half of them onto the engine.
 *
 * The two sets are deliberately different. The STORE's `armedTrackIds` is every
 * armed track — the RECORD key counts them and `lib/midiCapture` picks its own
 * tracks out of that list — while the ENGINE only ever hears about the tracks
 * whose take is a microphone's.
 */
function syncArmed(ids: readonly string[]): void {
  const e = getEngine();
  const micIds = micArmedIds(ids);
  const want = new Set(micIds);
  for (const id of e.armed()) if (!want.has(id)) e.disarm(id);
  const have = new Set(e.armed());
  // The arm source names the RESOLVED global input, not "whatever the OS calls
  // the default". Without it a take is captured on the OS default while its
  // latency compensation is filed under the device the user actually chose, so
  // a calibration measured on one microphone would be applied to another. The
  // engine builds its constraints with `micConstraints(source.deviceId)` and
  // that is a SOFT constraint, so a device that vanished between the enumerate
  // and the press still degrades to the OS default rather than refusing to
  // record. `''` keeps meaning exactly that default — `micConstraints` omits
  // the field entirely for an empty id, which is the behaviour every pass has
  // had until now.
  const deviceId = recordingDeviceKey();
  for (const id of micIds) if (!have.has(id)) e.arm(id, { kind: 'mic', deviceId });
  if (!sameIds(st().armedTrackIds, ids)) setState({ armedTrackIds: [...ids] });
}

/** Open the recorders, then release the transport. Never rejects. */
async function beginPass(): Promise<void> {
  const e = getEngine();
  startInFlight = true;
  stopPending = false;
  transportRolled = false;
  // Every armed track is a MIDI track: there is no recorder to open, and the
  // engine would reject an empty `start()` with `nothing-armed`. The rest of
  // the press is unchanged — the transport still rolls and the status still
  // cycles, which is the whole contract `lib/midiCapture` opens and closes on.
  micPassOpen = e.armed().length > 0;
  if (micPassOpen) {
    try {
      await e.start();
    } catch (err) {
      startInFlight = false;
      micPassOpen = false;
      setState({ status: 'idle', lastError: asRecordingError(err), levels: {} });
      pendingLevels = {};
      return;
    }
  }
  startInFlight = false;
  // A press that arrived while the inputs were opening: the recorders are live
  // NOW, so this is where that stop actually runs. Without it the engine would
  // be left recording with nothing able to stop it.
  if (stopPending) {
    stopPending = false;
    await finishPass();
    return;
  }
  deps.startTransport();
  // Asked AFTER the call rather than assumed from it: `liveMixer.start()` bails
  // on an empty (or undecodable) project and leaves `isPlaying` false, which is
  // precisely the pass whose take needs repairing.
  transportRolled = deps.isTransportPlaying();
}

/** Stop the recorders and lay the takes down. Never rejects. */
async function finishPass(): Promise<void> {
  setState({ status: 'stopping' });
  let takes: Take[] = [];
  // Nothing was opened on a MIDI-only pass, so there is nothing to stop and no
  // take to place — but the status flip above and the one below still happen,
  // because they are what closes the MIDI capture.
  const hadMic = micPassOpen;
  micPassOpen = false;
  if (hadMic) {
    try {
      takes = await getEngine().stop();
    } catch (err) {
      setState({ lastError: asRecordingError(err) });
    }
  }
  placeTakes(takes);
  // The pass is over, so there is no pass window any more. Cleared HERE and not
  // at the press, so `currentPassPunchWindow()` reads null at rest instead of
  // the last pass's edges — a caller asking between passes must not be handed a
  // window nothing is recording into. Safe for `lib/midiCapture`: it froze its
  // own copy when it opened, and it closes on the `stopping` flip above.
  passPunchWindow = null;
  pendingLevels = {};
  setState({ status: 'idle', levels: {} });
}

/**
 * THE punch gate, as a pure function of the mode and the editor's loop region:
 * the transport-second window a pass may write into, or `null` when it may
 * write anywhere (punch off, or no region to punch into). An open edge is
 * infinite rather than clamped so the crop below is one expression for all
 * three modes.
 *
 * Exported because it has THREE callers now and they must never disagree: the
 * take crop (through `punchWindow()` below), `lib/midiCapture`'s note crop
 * (through `currentPassPunchWindow()`), and the timeline's punch band in
 * `WaveformEditor`. A band that promised a window this refuses would be a lie
 * about what the next press is going to keep.
 *
 * The region terms are the whole of the gate, not a pre-filtered region:
 *   - `enabled` is the user saying the region is in force. A region that is SET
 *     but switched off punches nothing.
 *   - a region whose end is not past its start is no region — `setLoopRegion`
 *     itself refuses to enable one under 50 ms, and a degenerate one would crop
 *     every take to nothing.
 */
export function punchWindowFrom(
  punch: PunchMode,
  loop: { enabled: boolean; start: number; end: number } | null,
): { from: number; to: number } | null {
  if (punch === 'off') return null;
  if (!loop || !loop.enabled) return null;
  if (!Number.isFinite(loop.start) || !Number.isFinite(loop.end) || loop.end <= loop.start) return null;
  return {
    from: punch === 'out' ? -Infinity : loop.start,
    to: punch === 'in' ? Infinity : loop.end,
  };
}

/**
 * The window a press made RIGHT NOW would write into — the gate above, applied
 * to the current mode and the editor's current loop region. Exported for the
 * same reason the helper is: one derivation, however many surfaces read it.
 */
export function punchWindow(): { from: number; to: number } | null {
  const { loopEnabled, loopStart, loopEnd } = useEditorStore.getState();
  return punchWindowFrom(punchMode(), { enabled: loopEnabled, start: loopStart, end: loopEnd });
}

/**
 * The window the pass IN FLIGHT was pressed with, or `null` when no pass has
 * been pressed (or the last one punched nowhere). Read by `lib/midiCapture`,
 * which opens its captures on the flip into `recording`: for a pass with a
 * count-in that flip is a bar or more after the press, so reading the live
 * window there would crop the notes to a window the take crop is not using.
 * This is that one frozen window, so the two halves of a press can never
 * describe different edges.
 */
export function currentPassPunchWindow(): { from: number; to: number } | null {
  return passPunchWindow;
}

/**
 * Every take of ONE pass onto the timeline as ONE undo step.
 *
 * The whole placement loop runs inside `editorStore`'s `undoGroup` (T46H): the
 * group's first write opens a fresh step regardless of the coalescing clock,
 * every later write in the loop folds into it however many keys or gestures
 * the individual actions (`addTakeToClip`, `setCompRegionAt`, ...) use
 * internally, and closing the group cuts the burst again — so a single undo
 * takes the whole pass back off the timeline, whether it landed on one clip or
 * several. A bare `beginUndoStep()` before the group used to attempt the same
 * thing and did not work (see the "One caveat" paragraph below, which this
 * fixed) — it is not needed at all now, since the group already forces every
 * write inside it to ignore the coalescing clock entirely.
 *
 * `sourceDuration` is the take's own length: a take IS its source. With punch
 * off nothing is trimmed off its front either (`offsetIntoSource` is 0) and
 * nothing follows its end; a PUNCHED pass keeps that same source and trims the
 * clip to the window instead. Peaks are decoded afterwards and cached onto the
 * clip — a decode that fails costs the waveform drawing, never the take.
 *
 * A pass that lands ON a clip that is already there does not become a second
 * clip: `lib/takePlacement.matchClipForTake` matches it to that clip and it is
 * appended as an alternate TAKE which the clip then plays. The match runs after
 * the punch crop, so what is tested is the span that would have been laid down.
 * A take must be able to BE the clip — cover it end to end from a readable
 * head, `takePlacement.takeReadOffsetFor` — and its read head is rebased onto
 * the clip's start, because the clip keeps its own position and a take brings
 * bytes rather than a place to put them. A pass that covers only part of a clip
 * is not a take of it and lands beside it; that is comp material, and comping
 * has a UI coming (T46G).
 * The `record.takeMode` preference turns it off (`'clips'`), which is the
 * behaviour every pass had before takes existed.
 *
 * FIXED (T46H, was a caveat here): `editorStore.addTakeToClip` opens an undo
 * step of its own, so without the `undoGroup` wrap above, a pass that appends
 * to TWO clips at once cost two undos rather than one. The group fold — not a
 * `coalesce` option on `addTakeToClip` — is what closes it.
 *
 * `place.startSec` is the take's anchor already slid back by the device's
 * measured round trip, so it is where the clip really belongs on the timeline —
 * which is why the punch window is intersected with it rather than with the raw
 * anchor: the window is in timeline coordinates and so, now, is the clip.
 *
 * That same decode is the repair for a take whose CLOCK never moved (see the
 * header): a zero length, or a pass whose transport never rolled, takes its
 * length from the blob instead. The repair is deliberately narrow — a clip the
 * clock measured correctly is never overwritten, because the user may have
 * trimmed it in the moments the decode took.
 */
/**
 * Which take a clip is playing, as a comparable string — the take count and the
 * active index, plus a marker for a clip that is no longer there at all. Used
 * to decide whether a decode that started before the clip changed may still
 * write to it.
 */
function takeStateOf(clipId: string): string {
  const clip = useEditorStore.getState().clips.find((c) => c.id === clipId);
  if (!clip) return 'gone';
  // The active take's id is part of the identity so a remove-then-append that
  // lands on the same count and index still reads as a different clip.
  const i = clip.activeTakeIndex ?? 0;
  return `${clip.takes?.length ?? 0}:${i}:${clip.takes?.[i]?.id ?? ''}`;
}

function placeTakes(takes: readonly Take[]): void {
  if (takes.length === 0) return;
  const punchWin = passPunchWindow;
  // ONE device per pass, so the compensation is read once rather than per take:
  // a device swapped between two takes of the same press is not a thing that
  // can happen, and re-reading it would only invite the two to disagree.
  const comp = latencyCompSec();
  let faulted: RecordingError | null = null;
  let placed = 0;
  let dropped = 0;
  // The whole pass is one undo step, however many clips or takes it touches.
  // `addTakeToClip` and `setCompRegionAt` (below) each open an undo step of
  // their own, so without a group a pass that appends to two clips — or lands
  // on a comped clip, which appends AND retargets — would cost two or more
  // undos where a pass that lands new clips costs one (T46H). `undoGroup`
  // folds every write the loop makes into a single step regardless of the
  // keys or timing those actions use internally; see its doc in `editorStore`.
  useEditorStore.getState().undoGroup(() => {
    for (const take of takes) {
      if (take.meta.error) faulted = take.meta.error;
      const place = takeClipPlacement(take, { latencyCompSec: comp });
      const editor = useEditorStore.getState();
      if (!editor.tracks.some((t) => t.id === place.trackId)) continue; // the track was deleted mid-pass
      const track = editor.tracks.find((t) => t.id === place.trackId);
      const color = track?.color ?? FALLBACK_CLIP_COLOR;
      const measured = place.durationSec > 0 && transportRolled;
      // The punch crop. Only on a take the CLOCK measured: an unmeasured one has
      // no true extent to intersect the window with (its length is about to come
      // from the decode instead), so it is laid down whole — see the header.
      let startSec = place.startSec;
      let durationSec = place.durationSec;
      let offsetIntoSource: number = place.offsetIntoSource;
      if (measured && punchWin) {
        const from = Math.max(place.startSec, punchWin.from);
        const to = Math.min(place.startSec + place.durationSec, punchWin.to);
        // Wholly outside the window: nothing was punched in, so nothing lands —
        // and the take number is not burnt on a clip that does not exist.
        if (to <= from) {
          dropped += 1;
          continue;
        }
        startSec = from;
        durationSec = to - from;
        offsetIntoSource = from - place.startSec;
      }
      placed += 1;
      // A pass that lands ON a clip is a TAKE of it, not a second clip stacked
      // over the first. The crop above has already run, so the span tested is the
      // one that would have been laid down — a punched pass is matched against
      // where it really goes, not against the whole take it was cut out of.
      // `measured` gates it for the same reason the crop is gated: a take whose
      // clock never moved has no true extent yet — its length arrives from the
      // decode — and the repair that supplies it writes the CLIP's length, which
      // on an existing clip would resize somebody else's work.
      const span = { startSec, durationSec, offsetIntoSource };
      // A FROZEN track's clips are one printed stem, and unfreezing throws it away
      // for the originals it was printed from — a take hung off it would go with
      // it. The pass lands as its own clip, where it survives the unfreeze.
      // A STRETCHED or WARPED clip reads more (or other) source seconds than its
      // timeline span — `clipSourceSpanSec`, and the markers tie moments of the
      // OLD source to clip moments — so a take that covers the timeline span
      // does not cover what the clip reads. Such a clip is never a target.
      const candidates = measured && takeMode() === 'takes' && !track?.frozenOriginal
        ? editor.clips.filter(
            (c) => c.trackId === place.trackId && clipStretchRate(c) === 1 && !c.warpMarkers?.length,
          )
        : [];
      const onto = matchClipForTake(candidates, span);
      const target = onto ? editor.clips.find((c) => c.id === onto) : undefined;
      // The read head the CLIP needs, which is not the head the take was cropped
      // to: the clip keeps its own start, so the take is read from the moment the
      // clip begins. `matchClipForTake` refuses every clip this cannot be computed
      // for, so a null here is only reachable if the two disagreed — in which case
      // the pass takes the clip branch, which is always correct.
      const readOffset = target ? takeReadOffsetFor(target, span) : null;
      let clipId: string;
      if (target && readOffset !== null) {
        const alternate: ClipTake = {
          id: take.meta.id,
          label: nextTakeLabel(target),
          audioBlob: take.blob,
          mimeType: take.meta.mime,
          // Same field set the new-clip branch fills in, and for the same reason:
          // a take IS its source. The OFFSET is the one field that differs — it is
          // rebased onto the clip's head, so the clip reads the take from the
          // moment it itself begins.
          sourceDuration: place.durationSec,
          offsetIntoSource: readOffset,
        };
        // `addTakeToClip` seeds the clip's CURRENT media as take 1 when it has
        // none, so the pass it is replacing is never lost, and `activate` makes
        // the new one what the clip plays — which is what pressing record over a
        // phrase asks for. The clip keeps its own position and length: a take is
        // an alternate reading of that stretch of timeline, not a re-placement of
        // it.
        editor.addTakeToClip(target.id, alternate, { activate: true });
        clipId = target.id;
        // A COMPED clip does not play its active take — it plays its comp — so
        // `activate` alone would file the pass away inaudibly. The comp's LAST
        // region is retargeted onto it, which is the closest thing to "this is
        // what the clip plays now" that leaves the user's earlier boundaries
        // standing. (Retargeting every region would silently delete the comp.)
        const targetComp = target.comp;
        if (targetComp && targetComp.length > 0) {
          const newIndex = target.takes && target.takes.length > 0 ? target.takes.length : 1;
          useEditorStore.getState().setCompRegionAt(target.id, targetComp[targetComp.length - 1].startSec, newIndex);
        }
      } else {
        takeSeq += 1;
        clipId = editor.addClipToTrack({
          trackId: place.trackId,
          label: `Take ${takeSeq}`,
          audioBlob: take.blob,
          mimeType: take.meta.mime,
          // The SOURCE is the whole pass however the window cropped it: the bytes
          // outside the punch are trimmed off the clip, not thrown away.
          sourceDuration: place.durationSec,
          offsetIntoSource,
          durationSec,
          startSec,
          color,
        });
      }
      // WHAT THE DECODE IS ALLOWED TO WRITE, decided now rather than when it
      // resolves. `applyClipRender` writes the clip AND mirrors onto its ACTIVE
      // take, so a decode that lands after a later pass has appended and activated
      // a take would hang this pass's peaks on that pass's take, and the length
      // repair would re-length a clip that is no longer the one it measured. The
      // take list and the active index together are that identity: unchanged, the
      // clip is still playing what this pass just put on it.
      const placedTakeState = takeStateOf(clipId);
      void deps
        .computePeaks(take.blob, TAKE_PEAK_BINS)
        .then(({ peaks, duration }) => {
          const store = useEditorStore.getState();
          // Something moved under us: the peaks belong to a take that is no longer
          // the one the write would reach, and the newer pass's own decode is
          // about to supply the peaks for what IS playing.
          if (takeStateOf(clipId) !== placedTakeState) return;
          if (!measured && Number.isFinite(duration) && duration > 0) {
            // `applyClipRender` is history-exempt and keeps the redo stack, so the
            // pass is still one undo step however long the decode took.
            store.applyClipRender(clipId, { durationSec: duration, sourceDuration: duration }, peaks);
            return;
          }
          store.cachePeaks(clipId, peaks);
        })
        .catch(() => {
          /* a clip that draws flat is still a clip; the bytes are on it */
        });
    }
  });
  // A faulted take still LANDS — the spec flushes what it gathered — so the
  // fault is reported beside the clip rather than instead of it.
  if (faulted) setState({ lastError: faulted });
  // Every take fell outside the window. The recorders ran, the user pressed
  // stop, and the timeline is unchanged: without this the pass simply vanishes.
  if (placed === 0 && dropped > 0) setState({ lastNotice: notice(PUNCH_EMPTY_MESSAGE) });
}

/**
 * The HOT store: written on every status flip and 20 times a second per pass
 * while the meters run. It carries no `persist` — see `useRecordingPrefs` for
 * why the preference lives elsewhere.
 */
export const useRecordingStore = create<RecordingStoreState>()(() => ({
  status: 'idle',
  armedTrackIds: [],
  levels: {},
  lastError: null,
  lastNotice: null,

  recordPress: () => {
    // Any state but idle: the key is a STOP. That covers a cancel during the
    // count and a second press mid-pass, so the one key never needs a mode.
    if (st().status !== 'idle') {
      st().stopRecording();
      return;
    }
    const ids = deps.armedTrackIds();
    syncArmed(ids);
    if (ids.length === 0) {
      // Not a throw: the press is a no-op the UI explains. The engine would
      // raise the same code from `start()`, but asking it would open nothing
      // and lose the press to an unhandled rejection.
      setState({ lastError: new RecordingError('nothing-armed'), lastNotice: null });
      return;
    }
    // THE window for this pass, fixed here and read again at the stop.
    passPunchWindow = punchWindow();
    // A punch mode with nothing to punch into. The press is NOT refused —
    // the pass records whole, exactly as with punch off — so this goes on
    // the INFORMATIONAL channel and `lastError` stays null: nothing failed.
    const ignored = punchMode() !== 'off' && !passPunchWindow;
    setState({
      lastError: null,
      lastNotice: ignored ? notice(PUNCH_IGNORED_MESSAGE) : null,
    });

    // `MetronomeScheduler.countIn` can call `onDone` SYNCHRONOUSLY and still
    // hand back a non-null cancel, on two paths `shouldCountIn` cannot see from
    // out here: no engine context yet (it returns `() => undefined`), and a
    // count that works out to no clicks or no duration (it returns the REAL
    // cancel). Latching `counting` over a pass that has already been released
    // would leave the key lying about its state, and the next press would
    // "cancel" a count that is not running while the recorders kept rolling —
    // the press after THAT then gets `busy`. So the release wins: if it has
    // already run, this was a normal press and there is nothing to store.
    let released = false;
    const release = (): void => {
      released = true;
      countInCancel = null;
      setState({ status: 'recording' });
      void beginPass();
    };
    const cancel = deps.beginCountIn(release);
    if (released) return;
    if (!cancel) {
      release();
      return;
    }
    countInCancel = cancel;
    setState({ status: 'counting' });
  },

  stopRecording: () => {
    const status = st().status;
    if (status === 'idle' || status === 'stopping') return;
    if (status === 'counting') {
      // Nothing has moved: the playhead is where it was and no recorder was
      // ever opened, so there is nothing to undo — only the clicks to silence.
      countInCancel?.();
      countInCancel = null;
      deps.cancelCountIn();
      setState({ status: 'idle' });
      return;
    }
    if (startInFlight) {
      // The recorders are still opening. `beginPass` runs this stop the moment
      // they are live, rather than stopping an engine with nothing in it.
      stopPending = true;
      setState({ status: 'stopping' });
      return;
    }
    void finishPass();
  },

  clearError: () => setState({ lastError: null, lastNotice: null }),
}));

/* -------------------------------------------------------------------------- */
/*                                 the service                                */
/* -------------------------------------------------------------------------- */

/**
 * Start the recording service: build the engine, mirror the arm flags onto it
 * and watch the transport. Idempotent — safe under StrictMode's double mount
 * and safe to call from more than one mount point. It only subscribes; no input
 * is opened until a record press.
 */
export function initRecording(): void {
  if (started) return;
  started = true;
  syncArmed(deps.armedTrackIds());
  subscriptions.push(deps.subscribeArmed((ids) => syncArmed(ids)));
  subscriptions.push(
    deps.subscribeTransport((playing) => {
      // Stopping the transport stops the pass: a take cannot outlive the clock
      // it is anchored to. A count-in has no transport yet, so it is untouched.
      if (playing) return;
      if (st().status === 'recording') st().stopRecording();
    }),
  );
}

/**
 * Tear the service down: drop every subscription and the engine, and return the
 * store to idle. `initRecording()` may then be called again, with whatever
 * `setRecordingDeps` now holds. Used by the tests; a running pass is NOT
 * stopped for you — stop it first.
 */
export function resetRecording(): void {
  for (const off of subscriptions) {
    try {
      off();
    } catch {
      /* a subscription the owner already dropped */
    }
  }
  subscriptions = [];
  engine = null;
  started = false;
  countInCancel = null;
  startInFlight = false;
  micPassOpen = false;
  stopPending = false;
  takeSeq = 0;
  transportRolled = false;
  passPunchWindow = null;
  noticeSeq = 0;
  pendingLevels = {};
  lastLevelWrite = 0;
  setState({ status: 'idle', armedTrackIds: [], levels: {}, lastError: null, lastNotice: null });
}
